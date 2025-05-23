/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {getStringFromDataViewUTF8, objectAssign} from './utils.js';
import XmpTagNames from './xmp-tag-names.js';
import DOMParser from './dom-parser.js';
import {isMissingNamespaceError, addMissingNamespaces} from './xmp-namespaces.js';

export default {
    read
};

class ParseError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ParseError';
    }
}

function read(dataView, chunks, domParser) {
    const tags = {};

    if (typeof dataView === 'string') {
        readTags(tags, dataView, domParser);
        return tags;
    }

    const [standardXmp, extendedXmp] = extractCompleteChunks(dataView, chunks);

    const hasStandardTags = readTags(tags, standardXmp, domParser);

    if (extendedXmp) {
        const hasExtendedTags = readTags(tags, extendedXmp, domParser);

        if (!hasStandardTags && !hasExtendedTags) {
            // Some writers are not spec-compliant in that they split an XMP
            // metadata tree over both the standard XMP block and the extended
            // XMP block. If we failed parsing both of the XMPs in the regular
            // way, we try to combine them to see if that works better.
            delete tags._raw;
            readTags(tags, combineChunks(dataView, chunks), domParser);
        }
    }

    return tags;
}

// The first chunk is always the regular XMP document. Then there is something
// called extended XMP. The extended XMP is also a single XMP document but it
// can be divided into multiple chunks that need to be combined into one.
function extractCompleteChunks(dataView, chunks) {
    if (chunks.length === 0) {
        return [];
    }

    const completeChunks = [combineChunks(dataView, chunks.slice(0, 1))];
    if (chunks.length > 1) {
        completeChunks.push(combineChunks(dataView, chunks.slice(1)));
    }

    return completeChunks;
}

function combineChunks(dataView, chunks) {
    const totalLength = chunks.reduce((size, chunk) => size + chunk.length, 0);
    const combinedChunks = new Uint8Array(totalLength);
    let offset = 0;

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const slice = dataView.buffer.slice(chunk.dataOffset, chunk.dataOffset + chunk.length);
        combinedChunks.set(new Uint8Array(slice), offset);
        offset += chunk.length;
    }

    return new DataView(combinedChunks.buffer);
}

function readTags(tags, chunkDataView, domParser) {
    try {
        const {doc, raw} = getDocument(chunkDataView, domParser);
        tags._raw = (tags._raw || '') + raw;
        const rdf = getRDF(doc);

        objectAssign(tags, parseXMPObject(convertToObject(rdf, true)));
        return true;
    } catch (error) {
        return false;
    }
}

function getDocument(chunkDataView, _domParser) {
    const domParser = DOMParser.get(_domParser);
    if (!domParser) {
        console.warn('Warning: DOMParser is not available. It is needed to be able to parse XMP tags.'); // eslint-disable-line no-console
        throw new Error();
    }

    const xmlString = typeof chunkDataView === 'string' ? chunkDataView : getStringFromDataViewUTF8(chunkDataView, 0, chunkDataView.byteLength);
    const doc = parseFromString(domParser, trimXmlSource(xmlString));

    return {
        doc,
        raw: xmlString,
    };
}

function trimXmlSource(xmlSource) {
    return xmlSource.replace(/^.+(<\?xpacket begin)/, '$1').replace(/(<\?xpacket end=".*"\?>).+$/, '$1');
}

function parseFromString(domParser, xmlString, isRetry = false) {
    try {
        const doc = domParser.parseFromString(xmlString, 'application/xml');
        const errors = doc.getElementsByTagName('parsererror');
        if (errors.length > 0) {
            throw new ParseError(errors[0].textContent);
        }
        return doc;
    } catch (error) {
        if (error.name === 'ParseError' && isMissingNamespaceError(error) && !isRetry) {
            // Retry once after trying to fix the invalid XML.
            return parseFromString(domParser, addMissingNamespaces(xmlString), true);
        }
        throw error;
    }
}

function getRDF(node) {
    for (let i = 0; i < node.childNodes.length; i++) {
        if (node.childNodes[i].tagName === 'x:xmpmeta') {
            return getRDF(node.childNodes[i]);
        }
        if (node.childNodes[i].tagName === 'rdf:RDF') {
            return node.childNodes[i];
        }
    }

    throw new Error();
}

function convertToObject(node, isTopNode = false) {
    const childNodes = getChildNodes(node);

    if (hasTextOnlyContent(childNodes)) {
        if (isTopNode) {
            return {};
        }
        return getTextValue(childNodes[0]);
    }

    return getElementsFromNodes(childNodes);
}

function getChildNodes(node) {
    const elements = [];

    for (let i = 0; i < node.childNodes.length; i++) {
        elements.push(node.childNodes[i]);
    }

    return elements;
}

function hasTextOnlyContent(nodes) {
    return (nodes.length === 1) && (nodes[0].nodeName === '#text');
}

function getTextValue(node) {
    return node.nodeValue;
}

function getElementsFromNodes(nodes) {
    const elements = {};

    nodes.forEach((node) => {
        if (isElement(node)) {
            const nodeElement = getElementFromNode(node);

            if (elements[node.nodeName] !== undefined) {
                if (!Array.isArray(elements[node.nodeName])) {
                    elements[node.nodeName] = [elements[node.nodeName]];
                }
                elements[node.nodeName].push(nodeElement);
            } else {
                elements[node.nodeName] = nodeElement;
            }
        }
    });

    return elements;
}

function isElement(node) {
    return (node.nodeName) && (node.nodeName !== '#text');
}

function getElementFromNode(node) {
    return {
        attributes: getAttributes(node),
        value: convertToObject(node)
    };
}

function getAttributes(element) {
    const attributes = {};

    for (let i = 0; i < element.attributes.length; i++) {
        // Directly use the attribute value, assuming it's correctly decoded earlier or handled by the XML parser.
        attributes[element.attributes[i].nodeName] = element.attributes[i].value;
    }

    return attributes;
}

function parseXMPObject(xmpObject) {
    const tags = {};

    if (typeof xmpObject === 'string') {
        return xmpObject;
    }

    for (const nodeName in xmpObject) {
        let nodes = xmpObject[nodeName];

        if (!Array.isArray(nodes)) {
            nodes = [nodes];
        }

        nodes.forEach((node) => {
            objectAssign(tags, parseNodeAttributesAsTags(node.attributes));
            if (typeof node.value === 'object') {
                objectAssign(tags, parseNodeChildrenAsTags(node.value));
            }
        });
    }

    return tags;
}

function parseNodeAttributesAsTags(attributes) {
    const tags = {};

    for (const name in attributes) {
        try {
            if (isTagAttribute(name)) {
                tags[getLocalName(name)] = {
                    value: attributes[name],
                    attributes: {},
                    description: getDescription(attributes[name], name)
                };
            }
        } catch (error) {
            // Keep going and try to parse the rest of the tags.
        }
    }

    return tags;
}

function isTagAttribute(name) {
    return (name !== 'rdf:parseType') && (!isNamespaceDefinition(name));
}

function isNamespaceDefinition(name) {
    return name.split(':')[0] === 'xmlns';
}

function getLocalName(name) {
    if (/^MicrosoftPhoto(_\d+_)?:Rating$/i.test(name)) {
        return 'RatingPercent';
    }
    return name.split(':')[1];
}

function getDescription(value, name = undefined) {
    if (Array.isArray(value)) {
        const arrayDescription = getDescriptionOfArray(value);
        if ((name) && (typeof XmpTagNames[name] === 'function')) {
            return XmpTagNames[name](value, arrayDescription);
        }
        return arrayDescription;
    }
    if (typeof value === 'object') {
        return getDescriptionOfObject(value);
    }

    try {
        if ((name) && (typeof XmpTagNames[name] === 'function')) {
            return XmpTagNames[name](value);
        }
        // Directly return the value, assuming it's correctly decoded earlier.
        return value;
    } catch (error) {
        // If there's still an error, return the original value.
        return value;
    }
}

function getDescriptionOfArray(value) {
    return value.map((item) => {
        if (item.value !== undefined) {
            return getDescription(item.value);
        }
        return getDescription(item);
    }).join(', ');
}

function getDescriptionOfObject(value) {
    const descriptions = [];

    for (const key in value) {
        descriptions.push(`${getClearTextKey(key)}: ${getDescription(value[key].value)}`);
    }

    return descriptions.join('; ');
}

function getClearTextKey(key) {
    if (key === 'CiAdrCity') {
        return 'CreatorCity';
    }
    if (key === 'CiAdrCtry') {
        return 'CreatorCountry';
    }
    if (key === 'CiAdrExtadr') {
        return 'CreatorAddress';
    }
    if (key === 'CiAdrPcode') {
        return 'CreatorPostalCode';
    }
    if (key === 'CiAdrRegion') {
        return 'CreatorRegion';
    }
    if (key === 'CiEmailWork') {
        return 'CreatorWorkEmail';
    }
    if (key === 'CiTelWork') {
        return 'CreatorWorkPhone';
    }
    if (key === 'CiUrlWork') {
        return 'CreatorWorkUrl';
    }
    return key;
}

function parseNodeChildrenAsTags(children) {
    const tags = {};

    for (const name in children) {
        try {
            if (!isNamespaceDefinition(name)) {
                tags[getLocalName(name)] = parseNodeAsTag(children[name], name);
            }
        } catch (error) {
            // Keep going and try to parse the rest of the tags.
        }
    }

    return tags;
}

function parseNodeAsTag(node, name) {
    if (isDuplicateTag(node)) {
        return parseNodeAsDuplicateTag(node, name);
    }
    if (isEmptyResourceTag(node)) {
        return {value: '', attributes: {}, description: ''};
    }
    if (hasNestedSimpleRdfDescription(node)) {
        return parseNodeAsSimpleRdfDescription(node, name);
    }
    if (hasNestedStructureRdfDescription(node)) {
        return parseNodeAsStructureRdfDescription(node, name);
    }
    if (isCompactStructure(node)) {
        return parseNodeAsCompactStructure(node, name);
    }
    if (isArray(node)) {
        return parseNodeAsArray(node, name);
    }
    return parseNodeAsSimpleValue(node, name);
}

function isEmptyResourceTag(node) {
    return (node.attributes['rdf:parseType'] === 'Resource')
        && (typeof node.value === 'string')
        && (node.value.trim() === '');
}

function isDuplicateTag(node) {
    return Array.isArray(node);
}

function parseNodeAsDuplicateTag(node, name) {
    return parseNodeAsSimpleValue(node[node.length - 1], name);
}

function hasNestedSimpleRdfDescription(node) {
    return ((node.attributes['rdf:parseType'] === 'Resource') && (node.value['rdf:value'] !== undefined))
        || ((node.value['rdf:Description'] !== undefined) && (node.value['rdf:Description'].value['rdf:value'] !== undefined));
}

function parseNodeAsSimpleRdfDescription(node, name) {
    const attributes = parseNodeAttributes(node);

    if (node.value['rdf:Description'] !== undefined) {
        node = node.value['rdf:Description'];
    }

    objectAssign(attributes, parseNodeAttributes(node), parseNodeChildrenAsAttributes(node));

    const value = parseRdfValue(node);

    return {
        value,
        attributes,
        description: getDescription(value, name)
    };
}

function parseNodeAttributes(node) {
    const attributes = {};

    for (const name in node.attributes) {
        if ((name !== 'rdf:parseType') && (name !== 'rdf:resource') && (!isNamespaceDefinition(name))) {
            attributes[getLocalName(name)] = node.attributes[name];
        }
    }

    return attributes;
}

function parseNodeChildrenAsAttributes(node) {
    const attributes = {};

    for (const name in node.value) {
        if ((name !== 'rdf:value') && (!isNamespaceDefinition(name))) {
            attributes[getLocalName(name)] = node.value[name].value;
        }
    }

    return attributes;
}

function parseRdfValue(node) {
    return getURIValue(node.value['rdf:value']) || node.value['rdf:value'].value;
}

function hasNestedStructureRdfDescription(node) {
    return (node.attributes['rdf:parseType'] === 'Resource')
        || ((node.value['rdf:Description'] !== undefined) && (node.value['rdf:Description'].value['rdf:value'] === undefined));
}

function parseNodeAsStructureRdfDescription(node, name) {
    const tag = {
        value: {},
        attributes: {}
    };

    if (node.value['rdf:Description'] !== undefined) {
        objectAssign(tag.value, parseNodeAttributesAsTags(node.value['rdf:Description'].attributes));
        objectAssign(tag.attributes, parseNodeAttributes(node));
        node = node.value['rdf:Description'];
    }

    objectAssign(tag.value, parseNodeChildrenAsTags(node.value));

    tag.description = getDescription(tag.value, name);

    return tag;
}

function isCompactStructure(node) {
    return (Object.keys(node.value).length === 0)
        && (node.attributes['xml:lang'] === undefined)
        && (node.attributes['rdf:resource'] === undefined);
}

function parseNodeAsCompactStructure(node, name) {
    const value = parseNodeAttributesAsTags(node.attributes);

    return {
        value,
        attributes: {},
        description: getDescription(value, name)
    };
}

function isArray(node) {
    return getArrayChild(node.value) !== undefined;
}

function getArrayChild(value) {
    return value['rdf:Bag'] || value['rdf:Seq'] || value['rdf:Alt'];
}

function parseNodeAsArray(node, name) {
    let items = getArrayChild(node.value).value['rdf:li'];
    const attributes = parseNodeAttributes(node);
    const value = [];

    if (items === undefined) {
        items = [];
    } else if (!Array.isArray(items)) {
        items = [items];
    }

    items.forEach((item) => {
        value.push(parseArrayValue(item));
    });

    return {
        value,
        attributes,
        description: getDescription(value, name)
    };
}

function parseArrayValue(item) {
    if (hasNestedSimpleRdfDescription(item)) {
        return parseNodeAsSimpleRdfDescription(item);
    }
    if (hasNestedStructureRdfDescription(item)) {
        return parseNodeAsStructureRdfDescription(item).value;
    }
    if (isCompactStructure(item)) {
        return parseNodeAsCompactStructure(item).value;
    }

    return parseNodeAsSimpleValue(item);
}

function parseNodeAsSimpleValue(node, name) {
    const value = getURIValue(node) || parseXMPObject(node.value);

    return {
        value,
        attributes: parseNodeAttributes(node),
        description: getDescription(value, name)
    };
}

function getURIValue(node) {
    return node.attributes && node.attributes['rdf:resource'];
}
