// A small shared test for the public sdk: a non-null, non-array object.

export const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
