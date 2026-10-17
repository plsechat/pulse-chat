/** 32-bit FNV-1a: a stable, cheap hash for keying colours and buckets by id. */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const hash32 = (input: string): number => {
  let h = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
};

export { hash32 };
