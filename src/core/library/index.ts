// The user-library core: everything behind the four card buttons and the
// Lists tab. The UI, the API, and a future AI connection all call this.

export {
  markSeen,
  moveTitle,
  passTitle,
  removeTitle,
  restoreTitleState,
  skipTitle,
  updateRatingReview,
  watchlistTitle,
} from "./actions";
export { getList, getRatedCount, getTitleState, getUserTitleStates } from "./queries";
export { getUserSettings, updateUserSettings, validateSettingsPatch } from "../settings/user-settings";
export type { LibraryError, LibraryResult } from "./errors";
export { isValidRating, validateRating, validateReview } from "./validate";
export { ALLOWED_MOVES, isAllowedMove } from "./transitions";
export * from "./types";
