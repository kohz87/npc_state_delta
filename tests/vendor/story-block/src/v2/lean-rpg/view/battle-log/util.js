// Small value helpers shared by the battle log's record reader: object and list checks and the one-line word cutter.

export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const list = value => (Array.isArray(value) ? value : []);
export const words = (value, max = 80) => (typeof value === 'string' || typeof value === 'number' ? String(value).replace(/\s+/g, ' ').trim().slice(0, max) : '');
