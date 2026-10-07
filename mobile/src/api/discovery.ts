import { apiClient } from './client';
import { Gender, LookingFor, ProfilePhoto } from './profile';

// Typed wrappers around the discovery + swipe endpoints the feed screen needs
// (GET /discovery, POST /swipes). Both are authenticated; the shared client
// attaches the bearer token.

// A user's verification tier, derived server-side from their verification
// timestamps (see backend utils/verificationTier): 'nin' outranks 'phone'; null
// only for a user with neither — but discovery never returns those, so a shown
// candidate always has at least 'phone'.
export type VerificationTier = 'nin' | 'phone' | null;

// One candidate profile as shaped by DiscoveryController.shapeCandidate: the
// profile fields we render, plus a small, PUBLIC verification summary of its
// owner (never phone, role, or the owner's own discoverySettings).
export type Candidate = {
  _id: string; // the profile's id (NOT the swipe target — use userId for that)
  userId: string; // the owner's user id — this is the POST /swipes targetId
  name?: string;
  dob?: string; // ISO date string
  gender?: Gender;
  lookingFor?: LookingFor;
  bio?: string;
  interests?: string[];
  state?: string;
  lga?: string;
  photos?: ProfilePhoto[];
  user: {
    id: string;
    verificationTier: VerificationTier;
    phoneVerifiedAt: string | null;
    ninVerifiedAt: string | null;
  };
};

// GET /discovery response. `hasMore` lets the client page without a count query;
// candidates already exclude the requester, anyone they've swiped, and (by
// product rule) same-sex profiles.
export type DiscoveryResponse = {
  page: number;
  limit: number;
  hasMore: boolean;
  candidates: Candidate[];
};

// GET /discovery?page=&limit= — 1-based paging. The backend clamps limit to
// [1, 50]; we let it default so there's a single source of truth.
export async function getDiscovery(page = 1): Promise<DiscoveryResponse> {
  const { data } = await apiClient.get<DiscoveryResponse>('/discovery', {
    params: { page },
  });
  return data;
}

// A swipe decision. `superlike` exists server-side but this slice only sends
// like/pass (buttons); superlike can come with the gesture pass later.
export type SwipeAction = 'like' | 'pass' | 'superlike';

// POST /swipes response. `isMatch` is true only when this like/superlike
// completes a mutual like (a pass never matches); `match` carries the created
// Match document when it does.
export type SwipeResponse = {
  isMatch: boolean;
  match: {
    _id: string;
    userA: string;
    userB: string;
    status: 'active' | 'unmatched';
    matchedAt: string;
  } | null;
};

// POST /swipes { targetId, action } — records the swipe and reports whether it
// formed a mutual match. `targetId` is the candidate's USER id (candidate.userId),
// not the profile _id: the backend does User.findById(targetId) and excludes
// already-swiped users by Profile.userId.
export async function postSwipe(targetId: string, action: SwipeAction): Promise<SwipeResponse> {
  const { data } = await apiClient.post<SwipeResponse>('/swipes', { targetId, action });
  return data;
}
