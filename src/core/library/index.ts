// The user-library core: everything behind the four card buttons and the
// Lists tab. The UI, the API, and a future AI connection all call this.

export {
  markSeen,
  moveTitle,
  passTitle,
  removeRatingReview,
  removeTitle,
  restoreTitleState,
  skipTitle,
  updateRatingReview,
  watchlistTitle,
} from "./actions";
export {
  getList,
  getRatedCount,
  getTitleState,
  getTitleStatesFor,
  getTopRatedSeen,
  getUserTitleStates,
  readChangedElsewhere,
} from "./queries";
export {
  getDeckChoice,
  getUserSettings,
  MAX_PROVIDER_IDS,
  saveDeckChoice,
  updateUserSettings,
  validateDeckChoice,
  validateSettingsPatch,
  type UserSettings,
  type UserSettingsPatch,
} from "../settings/user-settings";
export type { CoreError, Result } from "../result";
export { isValidRating, validateRating, validateReview } from "./validate";
export { ALLOWED_MOVES, isAllowedMove, isChangedElsewhere } from "./transitions";
export * from "./types";
