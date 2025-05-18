/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Specification: http://www.libpng.org/pub/png/spec/1.2/

import {getStringFromBytesSimple, getNullTerminatedStringFromDataView} from './utils.js';
import Constants from './constants.js';

export default {
    isPngFile,
    findPngOffsets
};

// PNG signature: high-bit byte (0x89) + "PNG" + DOS line ending + DOS EOF + Unix line ending
const PNG_ID_BYTES = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const PNG_ID_LENGTH = PNG_ID_BYTES.length;

const PNG_CHUNK_LENGTH_SIZE = 4;
export const PNG_CHUNK_TYPE_SIZE = 4;
export const PNG_CHUNK_LENGTH_OFFSET = 0;
export const PNG_CHUNK_TYPE_OFFSET = PNG_CHUNK_LENGTH_SIZE;
export const PNG_CHUNK_DATA_OFFSET = PNG_CHUNK_LENGTH_SIZE + PNG_CHUNK_TYPE_SIZE;
const PNG_XMP_PREFIX = 'XML:com.adobe.xmp';
export const TYPE_TEXT = 'tEXt';
export const TYPE_ITXT = 'iTXt';
export const TYPE_ZTXT = 'zTXt';
export const TYPE_PHYS = 'pHYs';
export const TYPE_TIME = 'tIME';
export const TYPE_EXIF = 'eXIf';
export const TYPE_ICCP = 'iCCP';

function isPngFile(dataView) {
    if (!dataView || dataView.byteLength < PNG_ID_LENGTH) {
        return false;
    }

    // Check PNG signature byte by byte
    for (let i = 0; i < PNG_ID_LENGTH; i++) {
        if (dataView.getUint8(i) !== PNG_ID_BYTES[i]) {
            return false;
        }
    }
    return true;
}

function findPngOffsets(dataView, async) {
    const PNG_CRC_SIZE = 4;

    const offsets = {
        hasAppMarkers: false
    };

    let offset = PNG_ID_LENGTH;

    while (offset + PNG_CHUNK_LENGTH_SIZE + PNG_CHUNK_TYPE_SIZE <= dataView.byteLength) {
        if (Constants.USE_PNG_FILE && isPngImageHeaderChunk(dataView, offset)) {
            offsets.hasAppMarkers = true;
            offsets.pngHeaderOffset = offset + PNG_CHUNK_DATA_OFFSET;
        } else if (Constants.USE_XMP && isPngXmpChunk(dataView, offset)) {
            const dataOffset = getPngXmpDataOffset(dataView, offset);
            if (dataOffset !== undefined) {
                offsets.hasAppMarkers = true;
                offsets.xmpChunks = [{
                    dataOffset,
                    length: dataView.getUint32(offset + PNG_CHUNK_LENGTH_OFFSET) - (dataOffset - (offset + PNG_CHUNK_DATA_OFFSET))
                }];
            }
        } else if (isPngTextChunk(dataView, offset, async)) {
            offsets.hasAppMarkers = true;
            const chunkType = getStringFromBytesSimple(dataView, offset + PNG_CHUNK_TYPE_OFFSET, PNG_CHUNK_TYPE_SIZE);
            if (!offsets.pngTextChunks) {
                offsets.pngTextChunks = [];
            }
            offsets.pngTextChunks.push({
                length: dataView.getUint32(offset + PNG_CHUNK_LENGTH_OFFSET),
                type: chunkType,
                offset: offset + PNG_CHUNK_DATA_OFFSET
            });
        } else if (isPngExifChunk(dataView, offset)) {
            offsets.hasAppMarkers = true;
            offsets.tiffHeaderOffset = offset + PNG_CHUNK_DATA_OFFSET;
        } else if (Constants.USE_ICC && async && isPngIccpChunk(dataView, offset)) {
            offsets.hasAppMarkers = true;
            const chunkDataLength = dataView.getUint32(offset + PNG_CHUNK_LENGTH_OFFSET);
            const iccHeaderOffset = offset + PNG_CHUNK_DATA_OFFSET;
            const {profileName, compressionMethod, compressedProfileOffset} = parseIccHeader(dataView, iccHeaderOffset);
            if (!offsets.iccChunks) {
                offsets.iccChunks = [];
            }
            offsets.iccChunks.push({
                offset: compressedProfileOffset,
                length: chunkDataLength - (compressedProfileOffset - iccHeaderOffset),
                chunkNumber: 1,
                chunksTotal: 1,
                profileName,
                compressionMethod
            });
        } else if (isPngChunk(dataView, offset)) {
            offsets.hasAppMarkers = true;
            if (!offsets.pngChunkOffsets) {
                offsets.pngChunkOffsets = [];
            }
            offsets.pngChunkOffsets.push(offset + PNG_CHUNK_LENGTH_OFFSET);
        }

        offset += dataView.getUint32(offset + PNG_CHUNK_LENGTH_OFFSET)
            + PNG_CHUNK_LENGTH_SIZE
            + PNG_CHUNK_TYPE_SIZE
            + PNG_CRC_SIZE;
    }

    return offsets;
}

function isPngImageHeaderChunk(dataView, offset) {
    const PNG_CHUNK_TYPE_IMAGE_HEADER = 'IHDR';
    return getStringFromBytesSimple(dataView, offset + PNG_CHUNK_TYPE_OFFSET, PNG_CHUNK_TYPE_SIZE) === PNG_CHUNK_TYPE_IMAGE_HEADER;
}

function isPngXmpChunk(dataView, offset) {
    return (getStringFromBytesSimple(dataView, offset + PNG_CHUNK_TYPE_OFFSET, PNG_CHUNK_TYPE_SIZE) === TYPE_ITXT)
        && (getStringFromBytesSimple(dataView, offset + PNG_CHUNK_DATA_OFFSET, PNG_XMP_PREFIX.length) === PNG_XMP_PREFIX);
}

function isPngTextChunk(dataView, offset, async) {
    const chunkType = getStringFromBytesSimple(dataView, offset + PNG_CHUNK_TYPE_OFFSET, PNG_CHUNK_TYPE_SIZE);
    return chunkType === TYPE_TEXT || chunkType === TYPE_ITXT || (chunkType === TYPE_ZTXT && async);
}

function isPngExifChunk(dataView, offset) {
    return getStringFromBytesSimple(dataView, offset + PNG_CHUNK_TYPE_OFFSET, PNG_CHUNK_TYPE_SIZE) === TYPE_EXIF;
}

function isPngIccpChunk(dataView, offset) {
    return getStringFromBytesSimple(dataView, offset + PNG_CHUNK_TYPE_OFFSET, PNG_CHUNK_TYPE_SIZE) === TYPE_ICCP;
}

function isPngChunk(dataView, offset) {
    const SUPPORTED_PNG_CHUNK_TYPES = [TYPE_PHYS, TYPE_TIME];
    const chunkType = getStringFromBytesSimple(dataView, offset + PNG_CHUNK_TYPE_OFFSET, PNG_CHUNK_TYPE_SIZE);
    return SUPPORTED_PNG_CHUNK_TYPES.includes(chunkType);
}

function getPngXmpDataOffset(dataView, offset) {
    const COMPRESSION_FLAG_SIZE = 1;
    const COMPRESSION_METHOD_SIZE = 1;

    offset += PNG_CHUNK_DATA_OFFSET + PNG_XMP_PREFIX.length + COMPRESSION_FLAG_SIZE + COMPRESSION_METHOD_SIZE;

    let numberOfNullSeparators = 0;
    while (numberOfNullSeparators < 2 && offset < dataView.byteLength) {
        if (dataView.getUint8(offset) === 0x00) {
            numberOfNullSeparators++;
        }
        offset++;
    }
    if (numberOfNullSeparators < 2) {
        return undefined;
    }
    return offset;
}

function parseIccHeader(dataView, offset) {
    const NULL_SEPARATOR_SIZE = 1;
    const COMPRESSION_METHOD_SIZE = 1;

    const profileName = getNullTerminatedStringFromDataView(dataView, offset);
    offset += profileName.length + NULL_SEPARATOR_SIZE;

    const compressionMethod = dataView.getUint8(offset);
    offset += COMPRESSION_METHOD_SIZE;

    return {
        profileName,
        compressionMethod,
        compressedProfileOffset: offset
    };
}
