import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { clearTokens, getTokens, saveTokens, TokenPair } from './tokenStorage';
import { registerSignOutHandler } from './refreshSession';

// Holds the app's auth state and the actions that change it. The navigator reads
// `isAuthenticated` to decide between the auth stack and the app stack, so
// signing in/out automatically swaps the visible screens — no manual navigation.
type AuthContextValue = {
  isAuthenticated: boolean;
  isBootstrapping: boolean; // true while we read tokens from secure storage on launch
  signIn: (tokens: TokenPair) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isBootstrapping, setIsBootstrapping] = useState(true);

  // On launch, restore the session from the secure store so a returning user
  // skips the OTP flow. Failures are treated as "logged out", not a crash.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const tokens = await getTokens();
        if (!cancelled) setIsAuthenticated(!!tokens);
      } catch {
        if (!cancelled) setIsAuthenticated(false);
      } finally {
        if (!cancelled) setIsBootstrapping(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      isAuthenticated,
      isBootstrapping,
      async signIn(tokens: TokenPair) {
        await saveTokens(tokens);
        setIsAuthenticated(true);
      },
      async signOut() {
        await clearTokens();
        setIsAuthenticated(false);
      },
    }),
    [isAuthenticated, isBootstrapping],
  );

  // Give the REST client and the chat socket a way to force a sign-out
  // (refreshSession.ts's forceSignOut, called when neither can recover via a
  // refresh) without either importing this module — `signOut` only exists as
  // state inside this provider, there's nothing to import at the top level.
  useEffect(() => {
    registerSignOutHandler(value.signOut);
    return () => registerSignOutHandler(null);
  }, [value.signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
