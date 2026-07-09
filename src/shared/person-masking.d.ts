export const COMMON_CHINESE_SURNAMES: string;
export const COMMON_COMPOUND_SURNAMES: string[];
export const FAKE_PERSON_NAMES: string[];

export function defaultMaskedValue(
  originalValue: string,
  stableId: string,
  options?: {
    occupiedValues?: Set<string>;
    usedMaskedValues?: Set<string>;
    createPlaceholderFallback?: (
      stableId: string,
      occupiedValues: Set<string>,
      usedMaskedValues: Set<string>
    ) => string;
  }
): string;

export function fakePersonMaskedValue(occupiedValues: Set<string>, usedMaskedValues: Set<string>): string;
export function isLikelyPersonName(originalValue: string): boolean;
export function organizationMaskSuffix(originalValue: string): string;
