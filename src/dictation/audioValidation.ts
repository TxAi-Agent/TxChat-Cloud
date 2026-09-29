import { open } from "node:fs/promises";

export const AUDIO_HTTP_BODY_MAX_BYTES = 16_777_216;
export const AUDIO_PCM_MAX_BYTES = 10_500_000;
export const AUDIO_MAX_DURATION_MS = 300_000;

const RIFF_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const PCM_FORMAT_BYTES = 16;
const EXPECTED_CHANNELS = 1;
const EXPECTED_SAMPLE_RATE = 16_000;
const EXPECTED_BITS_PER_SAMPLE = 16;
const EXPECTED_BLOCK_ALIGN = 2;
const EXPECTED_BYTE_RATE = 32_000;

export class AudioValidationFailure extends Error {
  constructor() {
    super("Audio validation failed");
    this.name = "AudioValidationFailure";
  }
}

export type ValidatedWaveAudio = Readonly<{
  pcmDataOffset: number;
  pcmDataLength: number;
  durationMs: number;
  audioBytes: number;
}>;

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(
      buffer,
      offset,
      length - offset,
      position + offset,
    );
    if (result.bytesRead === 0) {
      throw new AudioValidationFailure();
    }
    offset += result.bytesRead;
  }
  return buffer;
}

function isFourCc(buffer: Buffer, offset: number, value: string): boolean {
  return buffer.toString("ascii", offset, offset + 4) === value;
}

export async function validateWaveFile(
  path: string,
): Promise<ValidatedWaveAudio> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const statistics = await handle.stat();
    if (
      !statistics.isFile() ||
      statistics.size < RIFF_HEADER_BYTES ||
      statistics.size > AUDIO_HTTP_BODY_MAX_BYTES
    ) {
      throw new AudioValidationFailure();
    }

    const riff = await readExactly(handle, RIFF_HEADER_BYTES, 0);
    if (
      !isFourCc(riff, 0, "RIFF") ||
      !isFourCc(riff, 8, "WAVE") ||
      riff.readUInt32LE(4) + 8 !== statistics.size
    ) {
      throw new AudioValidationFailure();
    }

    let position = RIFF_HEADER_BYTES;
    let foundFormat = false;
    let pcmDataOffset: number | undefined;
    let pcmDataLength: number | undefined;
    while (position < statistics.size) {
      if (position + CHUNK_HEADER_BYTES > statistics.size) {
        throw new AudioValidationFailure();
      }
      const chunk = await readExactly(handle, CHUNK_HEADER_BYTES, position);
      const chunkLength = chunk.readUInt32LE(4);
      const dataOffset = position + CHUNK_HEADER_BYTES;
      const paddedLength = chunkLength + (chunkLength % 2);
      const nextPosition = dataOffset + paddedLength;
      if (
        nextPosition < dataOffset ||
        nextPosition > statistics.size
      ) {
        throw new AudioValidationFailure();
      }

      if (isFourCc(chunk, 0, "fmt ")) {
        if (foundFormat || chunkLength !== PCM_FORMAT_BYTES) {
          throw new AudioValidationFailure();
        }
        const format = await readExactly(handle, PCM_FORMAT_BYTES, dataOffset);
        if (
          format.readUInt16LE(0) !== 1 ||
          format.readUInt16LE(2) !== EXPECTED_CHANNELS ||
          format.readUInt32LE(4) !== EXPECTED_SAMPLE_RATE ||
          format.readUInt32LE(8) !== EXPECTED_BYTE_RATE ||
          format.readUInt16LE(12) !== EXPECTED_BLOCK_ALIGN ||
          format.readUInt16LE(14) !== EXPECTED_BITS_PER_SAMPLE
        ) {
          throw new AudioValidationFailure();
        }
        foundFormat = true;
      } else if (isFourCc(chunk, 0, "data")) {
        if (pcmDataOffset !== undefined || chunkLength === 0) {
          throw new AudioValidationFailure();
        }
        pcmDataOffset = dataOffset;
        pcmDataLength = chunkLength;
      }
      position = nextPosition;
    }

    if (
      position !== statistics.size ||
      !foundFormat ||
      pcmDataOffset === undefined ||
      pcmDataLength === undefined ||
      pcmDataLength % EXPECTED_BLOCK_ALIGN !== 0 ||
      pcmDataLength > AUDIO_PCM_MAX_BYTES
    ) {
      throw new AudioValidationFailure();
    }
    const durationMs =
      (pcmDataLength * 1_000) / EXPECTED_BYTE_RATE;
    if (
      !Number.isFinite(durationMs) ||
      durationMs <= 0 ||
      durationMs > AUDIO_MAX_DURATION_MS
    ) {
      throw new AudioValidationFailure();
    }

    return Object.freeze({
      pcmDataOffset,
      pcmDataLength,
      durationMs,
      audioBytes: statistics.size,
    });
  } catch (error) {
    if (error instanceof AudioValidationFailure) {
      throw error;
    }
    throw new AudioValidationFailure();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
