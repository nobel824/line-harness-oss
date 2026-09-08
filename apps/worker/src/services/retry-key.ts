// LINE の X-Line-Retry-Key は UUID 形式でないと 400 になる。
// 「registration id + 用途」のような文字列をそのまま渡すと送信が全滅するので、
// 任意の seed から決定的に UUID を作ってからヘッダに載せる。
//
// 決定的であることが要件。送信成功後・DB 更新前に worker が落ちても、
// 次 tick で同じキーになれば LINE 側が重複を弾いてくれる。

/** 任意の seed から決定的に UUID (v5 相当) を作る。 */
export async function deriveRetryKey(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
