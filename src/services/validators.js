export function requiredText(value, fieldName = 'value') {
  const cleaned = String(value ?? '').trim();
  if (!cleaned) throw new ValidationError(`${fieldName} is required`);
  return cleaned;
}

export function parsePositiveInt(value, fieldName = 'number') {
  const cleaned = String(value ?? '').replace(/,/g, '').trim();
  if (!/^\d+$/.test(cleaned)) throw new ValidationError(`${fieldName} must be a whole number`);
  const parsed = Number(cleaned);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ValidationError(`${fieldName} must be greater than 0`);
  }
  return parsed;
}

export function parseMoneyAmount(value, fieldName = 'amount') {
  const cleaned = String(value ?? '').replace(/[₦,\s]/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) throw new ValidationError(`${fieldName} must be a valid amount`);
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new ValidationError(`${fieldName} must be greater than 0`);
  return parsed;
}

export function isOtp(value) {
  return /^\d{6}$/.test(String(value ?? '').trim());
}

export function isLikelyPropertyCode(value) {
  return /^GRD-[A-Z0-9\-]+$/i.test(String(value ?? '').trim());
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}
