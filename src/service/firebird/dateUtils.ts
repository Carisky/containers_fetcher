const ISO_DATE_ONLY_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

export const isIsoDateOnlyFormat = (value: string): boolean =>
  ISO_DATE_ONLY_PATTERN.test(value);

export const parseIsoDateOnly = (value: string): Date => {
  const match = ISO_DATE_ONLY_PATTERN.exec(value);
  if (!match) {
    throw new Error("Invalid date format. Expected YYYY-MM-DD.");
  }

  const [, yearRaw, monthRaw, dayRaw] = match;
  const year = Number.parseInt(yearRaw, 10);
  const month = Number.parseInt(monthRaw, 10);
  const day = Number.parseInt(dayRaw, 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    throw new Error(
      "Invalid date components. Expected numeric year, month, and day."
    );
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new Error("Invalid calendar date. Please verify the provided value.");
  }

  return date;
};
