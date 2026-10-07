# SabiPesin Mobile

Expo (managed) React Native app. First flow implemented: **phone OTP sign-in**
against the SabiPesin backend (`POST /auth/otp/request` → `POST /auth/otp/verify`),
storing the returned JWT access/refresh tokens in the device secure store and
landing on a placeholder Home screen.

## Setup

```bash
cd mobile
npm install
cp .env.example .env      # then set EXPO_PUBLIC_API_BASE_URL for your setup
npm start                 # or: npm run ios / npm run android
```

Open in **Expo Go** (scan the QR) or a simulator. No Xcode/Android Studio needed
for Expo Go.

## Configuration

The backend base URL is **not hardcoded** — it comes from `EXPO_PUBLIC_API_BASE_URL`
(read in `src/config/env.ts`). Host addressing when the backend runs locally on
port `3333`:

| Target            | URL                          |
| ----------------- | ---------------------------- |
| iOS simulator     | `http://localhost:3333`      |
| Android emulator  | `http://10.0.2.2:3333`       |
| Physical device   | `http://<your-LAN-IP>:3333`  |

If unset, a platform-aware localhost default is used and a warning is logged.

## Structure

```
mobile/
  App.tsx                      # providers + root navigator
  app.json                     # Expo config
  .env.example                 # EXPO_PUBLIC_API_BASE_URL
  src/
    config/env.ts              # reads API base URL from env
    api/
      client.ts                # axios instance (baseURL from env, bearer, 20s timeout)
      auth.ts                  # requestOtp / verifyOtp typed wrappers
      errors.ts                # ApiError + normalization (kind/status/retryAfter/attemptsLeft)
    auth/
      tokenStorage.ts          # expo-secure-store save/get/clear for JWTs
      AuthContext.tsx          # session state; bootstraps from secure storage
    navigation/
      RootNavigator.tsx        # auth stack vs app stack switch
      types.ts                 # route param lists
    components/PrimaryButton.tsx
    screens/
      PhoneEntryScreen.tsx     # POST /auth/otp/request
      OtpEntryScreen.tsx       # POST /auth/otp/verify + resend cooldown
      HomeScreen.tsx           # placeholder landing
    theme.ts
```

## Error handling

Backend error responses are normalized in `src/api/errors.ts` into an `ApiError`
with a `kind` (`validation` | `rate_limited` | `server` | `network` | `unknown`)
so screens can react without string-matching:

- **Invalid phone format** (`400`) — message shown under the phone field.
- **Wrong code** (`400`, may include `attemptsLeft`) — message + "N attempts left".
- **Expired code** (`400`) — prompts requesting a new one.
- **Rate limit** (`429`) — `Retry-After` header (or the "wait Ns" message) drives
  the resend countdown; hourly-cap message is shown as-is.
- **SMS provider failure** (`502`) / **network** — surfaced with a retriable message.
```
