// Typed route params for the native stack. `OtpEntry` needs the phone the user
// entered on the previous screen so it can call /auth/otp/verify with it.
export type AuthStackParamList = {
  PhoneEntry: undefined;
  OtpEntry: { phone: string };
};

// Onboarding order after sign-in: ProfileSetup → PhotoUpload → Home. The entry
// point is chosen from GET /profile/me — no profile (404) starts on ProfileSetup;
// a profile with no photos starts on PhotoUpload (a photoless profile can't be
// shown in discovery); an existing profile with photos goes straight to Home.
export type AppStackParamList = {
  ProfileSetup: undefined;
  PhotoUpload: undefined;
  Home: undefined;
  // Discovery filters (PUT /profile/discovery-settings), reached from the
  // Discover header's filter icon.
  DiscoverySettings: undefined;
  // The active-matches list (GET /matches); each row opens Chat.
  Matches: undefined;
  // A conversation, reached from the match overlay or the matches list. Keyed by
  // matchId — the chat resolves the conversationId via POST /matches/:id/conversation
  // on open. The optional name/photo let the header render instantly before that
  // round-trip resolves; the screen still refreshes them from the response.
  Chat: { matchId: string; otherUserName?: string; otherUserPhotoUrl?: string | null };
  // Subscription status + Paystack upgrade (Android/web only — iOS shows a
  // coming-soon state), reached from the Discover header.
  Subscription: undefined;
};
