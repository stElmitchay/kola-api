//@ts-check

/**
 * Validate and normalize a Sierra Leone phone number
 * Accepts formats: +23276123456, 23276123456, 076123456, 76123456
 * @param {string} phone
 * @returns {{ valid: boolean, normalized: string | null }}
 */
export function validatePhoneNumber(phone) {
  const cleaned = phone.replace(/[\s\-()]/g, '');

  const patterns = [
    /^\+?(232)(7[0-9]|3[0-3])\d{6}$/,
    /^0?(7[0-9]|3[0-3])\d{6}$/
  ];

  for (const pattern of patterns) {
    if (pattern.test(cleaned)) {
      const digits = cleaned.replace(/^\+/, '');

      if (digits.startsWith('232')) {
        return { valid: true, normalized: `+${digits}` };
      }

      const withoutLeadingZero = digits.replace(/^0/, '');
      return { valid: true, normalized: `+232${withoutLeadingZero}` };
    }
  }

  return { valid: false, normalized: null };
}
