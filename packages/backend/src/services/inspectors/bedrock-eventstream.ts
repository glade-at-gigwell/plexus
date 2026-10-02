/**
 * Observable tap for Bedrock ConverseStream's AWS event-stream response.
 *
 * ConverseStream returns `application/vnd.amazon.eventstream`: a sequence of
 * binary frames (prelude, headers, JSON payload, CRCs), not SSE. The debug
 * pipeline is line/SSE oriented and cannot reconstruct it, so this observer
 * frames the bytes with the established @smithy event-stream codec and retains
 * the `metadata` event payload, whose `serviceTier.type` is the tier the
 * provider actually served.
 *
 * Properties that matter for the raw passthrough relay:
 *   - it only observes bytes; it never transforms or re-emits them,
 *   - a frame split across chunks is buffered until complete,
 *   - a cancelled/truncated stream simply drops the partial tail (close()),
 *   - malformed frames are ignored so observation can never break the relay,
 *   - buffering is bounded, so a bogus frame length cannot grow memory.
 */

import { EventStreamCodec } from '@smithy/core/event-streams';

/** prelude (8) + prelude CRC (4) + message CRC (4). */
const MIN_FRAME_LENGTH = 16;
/** ConverseStream frames are small; anything larger is treated as corrupt. */
const MAX_FRAME_LENGTH = 4 * 1024 * 1024;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

// Constructor order is (toUtf8: Encoder, fromUtf8: Decoder); in Smithy terms an
// Encoder turns bytes into a string and a Decoder turns a string into bytes.
const codec = new EventStreamCodec(
  (input: Uint8Array) => new TextDecoder().decode(input),
  (input: string) => new TextEncoder().encode(input)
);

export class BedrockEventStreamMetadataObserver {
  private pending: Buffer = Buffer.alloc(0);
  private metadata: Record<string, unknown> | null = null;
  private closed = false;

  /** Observe another chunk of the binary response without retaining the body. */
  feed(chunk: Uint8Array | Buffer): void {
    if (this.closed || chunk.byteLength === 0) return;
    // Copy: stream buffers may be pooled/reused after this call returns.
    const bytes = Buffer.from(chunk);
    this.pending = this.pending.length === 0 ? bytes : Buffer.concat([this.pending, bytes]);
    if (this.pending.length > MAX_PENDING_BYTES) {
      this.close();
      return;
    }
    this.drain();
  }

  /** Stop observing and release buffered bytes (safe on cancellation). */
  close(): void {
    this.closed = true;
    this.pending = Buffer.alloc(0);
  }

  /** Last fully-received `metadata` event payload, or null. */
  getReconstructed(): Record<string, unknown> | null {
    return this.metadata;
  }

  private drain(): void {
    while (!this.closed && this.pending.length >= MIN_FRAME_LENGTH) {
      const totalLength = this.pending.readUInt32BE(0);
      if (totalLength < MIN_FRAME_LENGTH || totalLength > MAX_FRAME_LENGTH) {
        this.close();
        return;
      }
      if (this.pending.length < totalLength) return;
      const frame = this.pending.subarray(0, totalLength);
      this.pending = this.pending.subarray(totalLength);
      this.observeFrame(frame);
    }
  }

  private observeFrame(frame: Buffer): void {
    try {
      const message = codec.decode(frame);
      const eventType = message.headers[':event-type'];
      if (!eventType || eventType.type !== 'string' || eventType.value !== 'metadata') return;
      const payload = Buffer.from(message.body).toString('utf8');
      if (!payload) return;
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.metadata = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed/truncated frame — ignore rather than disturb the relay.
    }
  }
}
