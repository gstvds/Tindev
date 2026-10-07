import { apiClient } from './client';
import { ApiError } from './errors';

// Typed wrappers around the profile endpoints the setup screen needs (spec §6).
// Photos, discoverySettings and location are managed by their own endpoints and
// are intentionally NOT written here — see EDITABLE_FIELDS in ProfileController.

export type LookingFor = 'casual' | 'serious' | 'marriage' | 'friendship';

// Opposite-sex matching by product decision — gender is a closed male/female set
// and discovery derives the match target from it (no separate preference field).
export type Gender = 'male' | 'female';

// A photo subdocument as returned by the backend. `_id` is what DELETE
// /profile/photos/:photoId expects; the backend guarantees exactly one primary.
export type ProfilePhoto = {
  _id: string;
  url: string;
  publicId?: string;
  isPrimary: boolean;
};

// The owner's discovery filters, managed only by PUT /profile/discovery-settings.
// `ageRange` is absent on a profile that has never set it (the schema has no
// default for it, unlike the other two). Stripped from OTHER users' profiles by
// the backend, but returned in full on GET /profile/me — so this is safe to read
// for the current user.
export type DiscoverySettings = {
  showOnlyNinVerified: boolean;
  maxDistanceKm: number;
  ageRange?: { min: number; max: number };
};

// The subset of the Profile model this screen reads/writes. The backend returns
// the full document; we only type what we use.
export type Profile = {
  _id: string;
  userId: string;
  name?: string;
  dob?: string; // ISO date string
  gender?: Gender;
  lookingFor?: LookingFor;
  bio?: string;
  interests?: string[];
  state?: string;
  lga?: string;
  // Managed by the photo endpoints (POST/DELETE /profile/photos), not PUT
  // /profile/me. Absent on a freshly-created profile until the first upload.
  photos?: ProfilePhoto[];
  // Managed by PUT /profile/discovery-settings. Present on GET /profile/me for
  // the owner (the schema defaults showOnlyNinVerified/maxDistanceKm), though
  // `ageRange` may be undefined until first set.
  discoverySettings?: DiscoverySettings;
};

// PUT /profile/me accepts any subset of the writable fields (it upserts). We only
// send fields the user actually filled in, so empty optionals aren't stored as "".
export type UpdateProfileInput = {
  name?: string;
  dob?: string;
  gender?: Gender;
  lookingFor?: LookingFor;
  bio?: string;
  interests?: string[];
  state?: string;
  lga?: string;
};

// The fields ProfileSetup treats as required for a usable profile. They are all
// OPTIONAL in the Mongoose schema, and the photo-upload endpoint upserts a bare
// profile (no fields set) the first time a user uploads — so a Profile document
// can exist (GET /profile/me → 200) while none of these are populated. The
// routing gate must therefore check completeness, not mere existence, or a user
// who reached photos before setup would skip the profile form entirely.
export const REQUIRED_PROFILE_FIELDS: (keyof Profile)[] = ['name', 'dob', 'gender', 'lookingFor'];

// True only when every required field is actually populated. Mirrors the
// client-side required set in ProfileSetupScreen so the gate and the form agree
// on what "complete" means.
export function isProfileComplete(profile: Profile | null | undefined): boolean {
  if (!profile) return false;
  return !!profile.name?.trim() && !!profile.dob && !!profile.gender && !!profile.lookingFor;
}

// GET /profile/me — 200 with the profile, or 404 when the user has none yet. The
// 404 is not an error condition for the caller (it drives routing to setup), so
// callers should inspect `err.status === 404` rather than treating it as failure.
export async function getMyProfile(): Promise<Profile> {
  const { data } = await apiClient.get<Profile>('/profile/me');
  return data;
}

// PUT /profile/me — upsert. Creates the profile on first call, updates thereafter.
export async function updateMyProfile(input: UpdateProfileInput): Promise<Profile> {
  const { data } = await apiClient.put<Profile>('/profile/me', input);
  return data;
}

// A local image chosen from the library/camera, ready to upload. `uri` is the
// on-device file URI; `name`/`type` populate the multipart part so the backend's
// multer image filter (image/*) accepts it.
export type PhotoUpload = {
  uri: string;
  name: string;
  type: string;
};

// POST /profile/photos — one image per request as multipart/form-data under the
// field name "photo" (the exact name the backend's multer expects). The backend
// appends it to the profile's photos array, marks the first photo primary
// automatically, and returns the FULL updated profile (201) — which we return so
// the caller can read back each photo's `_id` and `isPrimary`. Upload one at a
// time: the primary flag is decided by array position server-side, so serial
// uploads keep "first chosen = primary" and avoid a two-primaries race.
export async function uploadProfilePhoto(photo: PhotoUpload): Promise<Profile> {
  const form = new FormData();
  // React Native's FormData accepts a { uri, name, type } file part; the type
  // cast is the standard RN idiom (the web File type doesn't apply here).
  form.append('photo', { uri: photo.uri, name: photo.name, type: photo.type } as any);

  const { data } = await apiClient.post<Profile>('/profile/photos', form, {
    // Override the client's default application/json. RN fills in the multipart
    // boundary itself when the body is FormData.
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

// DELETE /profile/photos/:photoId — removes one photo (by its subdoc `_id`),
// deletes the backing asset, promotes a new primary if needed, and returns the
// FULL updated profile (200).
export async function deleteProfilePhoto(photoId: string): Promise<Profile> {
  const { data } = await apiClient.delete<Profile>(`/profile/photos/${photoId}`);
  return data;
}

// PUT /profile/discovery-settings input. Every field is optional server-side
// (only the provided ones are written), but the settings screen sends all three
// to keep the saved filters == the form state.
export type UpdateDiscoverySettingsInput = {
  showOnlyNinVerified?: boolean;
  maxDistanceKm?: number;
  ageRange?: { min: number; max: number };
};

// PUT /profile/discovery-settings — the ONLY write path allowed to set
// showOnlyNinVerified, because it enforces the reciprocity rule: enabling the
// NIN-only filter requires the caller to be NIN-verified. When they aren't, the
// backend responds 403 with `{ code: 'NIN_REQUIRED' }` and persists nothing —
// callers should inspect `err.status === 403 && err.code === 'NIN_REQUIRED'`.
// Returns the full updated profile on success.
export async function updateDiscoverySettings(
  input: UpdateDiscoverySettingsInput,
): Promise<Profile> {
  const { data } = await apiClient.put<Profile>('/profile/discovery-settings', input);
  return data;
}

// The writable fields this screen owns — used to decide which parsed backend
// error paths belong to a form field vs. the form-level banner.
const FORM_FIELDS = ['name', 'dob', 'gender', 'lookingFor', 'bio', 'interests', 'state', 'lga'];

// Turn a backend 400 into a per-field error map so the screen can show messages
// inline instead of one generic banner. The central handler returns the raw
// Mongoose message as `{ error }`, in one of two shapes:
//   ValidationError: "Profile validation failed: lookingFor: `x` is not a valid
//                     enum value for path `lookingFor`., dob: Cast to Date failed…"
//   CastError:       'Cast to date failed for value "…" at path "dob"'
// Anything we can't attribute to a known field is returned under the `_form` key.
export function parseFieldErrors(err: ApiError): Record<string, string> {
  if (err.kind !== 'validation') return { _form: err.message };

  const msg = err.message;
  const result: Record<string, string> = {};

  const marker = 'validation failed: ';
  const idx = msg.indexOf(marker);
  if (idx !== -1) {
    // Mongoose joins multiple field errors with ", ". Each part is "path: detail".
    const body = msg.slice(idx + marker.length);
    for (const part of body.split(', ')) {
      const sep = part.indexOf(': ');
      if (sep === -1) continue;
      const field = part.slice(0, sep).trim();
      const detail = part.slice(sep + 2).trim().replace(/\.$/, '');
      if (FORM_FIELDS.includes(field)) result[field] = detail;
    }
  } else {
    // CastError style — pull the field out of `at path "dob"`.
    const m = /at path "(\w+)"/.exec(msg);
    if (m && FORM_FIELDS.includes(m[1])) {
      result[m[1]] = `That value isn't valid for ${m[1]}.`;
    }
  }

  // Couldn't attribute it to any field — show the raw message at form level.
  if (Object.keys(result).length === 0) result._form = msg;
  return result;
}
