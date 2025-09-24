export const getFirstQueryParam = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    for (const element of value) {
      if (typeof element === "string") {
        return element;
      }
    }
  }

  return "";
};
