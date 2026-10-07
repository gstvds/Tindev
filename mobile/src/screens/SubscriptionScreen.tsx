import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

import { getMyEmail, updateMyEmail } from '../api/account';
import { ApiError } from '../api/errors';
import {
  getSubscriptionStatus,
  subscribeToUnlimited,
  SubscriptionStatusResponse,
} from '../api/subscriptions';
import { PrimaryButton } from '../components/PrimaryButton';
import { colors, spacing } from '../theme';

// Polling cadence/budget after the Paystack browser session closes. The webhook
// that actually activates the plan runs async server-side, so there's no signal
// at browser-close time for success vs. cancel vs. dismiss — we just wait and see.
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 15; // ~30s

// Mirrors the backend's own check (AccountController.updateEmail / User.js) so
// a bad value is caught locally before any network call — this is the one
// case that's allowed to block the Upgrade button (there's no address yet to
// send). Empty is valid — it's the optional field's "cleared" state.
const EMAIL_RE = /^\S+@\S+\.\S+$/;
const EMAIL_MAX_LENGTH = 254;

function validateEmailFormat(value: string): string | null {
  if (!value) return null;
  if (value.length > EMAIL_MAX_LENGTH) return `Email must be at most ${EMAIL_MAX_LENGTH} characters.`;
  if (!EMAIL_RE.test(value)) return 'Enter a valid email address.';
  return null;
}

type Screen = 'loading' | 'ready' | 'error';
// 'ready' states beyond the base status fetch: 'checkout' while the browser is
// open/polling, 'success' once the webhook flips the plan, 'timeout' when the
// poll budget runs out without an answer either way.
type Phase = 'idle' | 'checkout' | 'polling' | 'success' | 'timeout';

type EmailSaveState = 'idle' | 'saving' | 'saved';
// What trySaveEmail actually did, so callers (onUpgrade vs. the Save button)
// can each decide for themselves whether that result should block them.
type EmailSaveResult = { ok: true } | { ok: false; reason: 'format' | 'save-failed' };

export function SubscriptionScreen() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<SubscriptionStatusResponse | null>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [actionError, setActionError] = useState<string | null>(null);

  // Receipt-email field (App Store: must be optional and never block app use).
  // `email` is the live input; `savedEmail` is the last value confirmed by the
  // backend (null means "nothing saved") — comparing the two is how we know
  // whether there's an unsaved change to push before checkout.
  const [email, setEmail] = useState('');
  const [savedEmail, setSavedEmail] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailSaveState, setEmailSaveState] = useState<EmailSaveState>('idle');
  // Shown only when an Upgrade-triggered save fails for a non-format reason —
  // the purchase must continue regardless, this just tells the user why their
  // receipt might still go to the old/synthesized address.
  const [emailNotice, setEmailNotice] = useState<string | null>(null);

  // Guards a poll loop that outlives the screen (user navigates away mid-poll).
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setScreen('loading');
    setLoadError(null);
    try {
      const s = await getSubscriptionStatus();
      setStatus(s);
      setScreen('ready');
    } catch (e) {
      const err = e as ApiError;
      setLoadError(err.message);
      setScreen('error');
      return;
    }

    // Pre-fill the receipt-email field. Best-effort: this is an optional,
    // secondary field, so a failed prefill just leaves it blank rather than
    // blocking the screen (the required subscription-status fetch above is
    // the only thing that can put the screen in an error state).
    try {
      const e = await getMyEmail();
      setEmail(e ?? '');
      setSavedEmail(e ?? null);
    } catch {
      // Leave the field blank; the user can still type and save.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const isActiveUnlimited = status?.plan === 'unlimited' && status?.status === 'active';
  const showUpgradeFlow = !isActiveUnlimited && Platform.OS === 'android';

  function onEmailChange(value: string) {
    setEmail(value);
    if (emailError) setEmailError(null);
    if (emailSaveState !== 'idle') setEmailSaveState('idle');
    if (emailNotice) setEmailNotice(null);
  }

  // Validates locally, then saves only if the (valid) value actually differs
  // from what's already on the account. Shared by the Save button and
  // onUpgrade's save-before-checkout step — each decides independently what a
  // non-'ok' result means for it (see callers).
  async function trySaveEmail(): Promise<EmailSaveResult> {
    const trimmed = email.trim();
    const formatError = validateEmailFormat(trimmed);
    if (formatError) {
      setEmailError(formatError);
      return { ok: false, reason: 'format' };
    }
    setEmailError(null);

    if (trimmed === (savedEmail ?? '')) {
      return { ok: true };
    }

    setEmailSaveState('saving');
    try {
      const saved = await updateMyEmail(trimmed || null);
      setEmail(saved ?? '');
      setSavedEmail(saved ?? null);
      setEmailSaveState('saved');
      setEmailNotice(null);
      return { ok: true };
    } catch {
      setEmailSaveState('idle');
      return { ok: false, reason: 'save-failed' };
    }
  }

  async function onSaveEmail() {
    const result = await trySaveEmail();
    if (!result.ok && result.reason === 'save-failed') {
      setEmailError('Could not save your email. Please try again.');
    }
  }

  async function pollUntilActiveOrTimeout() {
    setPhase('polling');
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      if (!mountedRef.current) return;

      try {
        const s = await getSubscriptionStatus();
        if (!mountedRef.current) return;
        setStatus(s);
        if (s.plan === 'unlimited' && s.status === 'active') {
          setPhase('success');
          return;
        }
      } catch {
        // A transient error mid-poll isn't fatal — just keep polling on the
        // existing schedule rather than surfacing a scary error for a blip.
      }
    }
    if (mountedRef.current) setPhase('timeout');
  }

  async function onUpgrade() {
    if (Platform.OS !== 'android') return;
    setActionError(null);

    // Save-before-checkout: a malformed value blocks (inline error, no
    // checkout — nothing valid to send yet). A save that fails for any other
    // reason (network/server) must NOT block the purchase — Apple requires
    // this field to never gate app use — so checkout proceeds and we just
    // flag that the receipt may not reach the new address this time.
    const emailResult = await trySaveEmail();
    if (!emailResult.ok) {
      if (emailResult.reason === 'format') return;
      setEmailNotice("We couldn't save your receipt email, but your upgrade will continue.");
    }

    setPhase('checkout');
    try {
      const { authorizationUrl } = await subscribeToUnlimited();
      // Opened for ANY close reason (pay, cancel, dismiss) — WebBrowser can't
      // reliably distinguish them, so polling below is the only source of truth.
      await WebBrowser.openAuthSessionAsync(authorizationUrl);
      await pollUntilActiveOrTimeout();
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 409) {
        // Already active — not an error, just refresh to show the real state.
        await load();
        setPhase('idle');
      } else {
        setActionError(err.message);
        setPhase('idle');
      }
    }
  }

  if (screen === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (screen === 'error') {
    return (
      <View style={styles.stateContainer}>
        <View style={styles.stateContent}>
          <Text style={styles.stateTitle}>Couldn’t load your subscription</Text>
          <Text style={styles.stateText}>{loadError}</Text>
        </View>
        <PrimaryButton title="Try again" onPress={() => void load()} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Unlimited</Text>

      <View style={styles.statusCard}>
        <Text style={styles.statusLabel}>Current plan</Text>
        <Text style={styles.statusValue}>
          {isActiveUnlimited ? 'Unlimited' : 'Free'}
        </Text>
        {isActiveUnlimited && status?.currentPeriodEnd ? (
          <Text style={styles.statusDetail}>
            Renews {new Date(status.currentPeriodEnd).toLocaleDateString()}
          </Text>
        ) : null}
      </View>

      {isActiveUnlimited ? (
        <Text style={styles.subtitle}>
          You have unlimited swipes, can see who liked you, and get the advanced filters.
        </Text>
      ) : (
        <Text style={styles.subtitle}>
          Lift the daily swipe cap, see who liked you, and unlock advanced filters.
        </Text>
      )}

      {actionError ? <Text style={styles.formError}>{actionError}</Text> : null}

      {showUpgradeFlow && (
        <Field label="Email for your receipt" error={emailError} optional>
          <Text style={styles.receiptNote}>Only used to send you a payment receipt.</Text>
          <TextInput
            style={[styles.input, !!emailError && styles.inputError]}
            value={email}
            onChangeText={onEmailChange}
            placeholder="you@example.com"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            editable={emailSaveState !== 'saving' && phase !== 'checkout' && phase !== 'polling'}
          />
          <View style={styles.emailSaveRow}>
            <Pressable
              onPress={() => void onSaveEmail()}
              disabled={emailSaveState === 'saving'}
              style={({ pressed }) => [
                styles.saveBtn,
                emailSaveState === 'saving' && styles.saveBtnDisabled,
                pressed && emailSaveState !== 'saving' && styles.saveBtnPressed,
              ]}
            >
              {emailSaveState === 'saving' ? (
                <ActivityIndicator color={colors.primary} size="small" />
              ) : (
                <Text style={styles.saveBtnText}>Save</Text>
              )}
            </Pressable>
            {emailSaveState === 'saved' && !emailError ? (
              <Text style={styles.savedText}>Saved</Text>
            ) : null}
          </View>
        </Field>
      )}

      {emailNotice ? <Text style={styles.formError}>{emailNotice}</Text> : null}

      {showUpgradeFlow && (
        <View style={styles.action}>
          <PrimaryButton
            title="Upgrade to Unlimited"
            onPress={() => void onUpgrade()}
            loading={phase === 'checkout' || phase === 'polling'}
            disabled={emailSaveState === 'saving'}
          />
        </View>
      )}

      {!isActiveUnlimited && Platform.OS === 'ios' && (
        <View style={styles.notice}>
          <Text style={styles.noticeTitle}>Coming soon</Text>
          <Text style={styles.noticeText}>
            Upgrading to Unlimited on iOS isn’t available yet.
          </Text>
        </View>
      )}

      {phase === 'polling' && (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>Checking payment status…</Text>
        </View>
      )}

      {phase === 'success' && (
        <View style={styles.notice}>
          <Text style={styles.noticeTitle}>You’re on Unlimited</Text>
          <Text style={styles.noticeText}>Your upgrade is active.</Text>
        </View>
      )}

      {phase === 'timeout' && (
        <View style={styles.notice}>
          <Text style={styles.noticeTitle}>Still processing</Text>
          <Text style={styles.noticeText}>
            We haven’t confirmed your payment yet. This can take a few minutes — check
            back shortly.
          </Text>
        </View>
      )}
    </View>
  );
}

// A labelled form row with an optional hint and an inline error message.
// Mirrors ProfileSetupScreen's local `Field` component (not exported there).
function Field({
  label,
  error,
  optional,
  children,
}: {
  label: string;
  error?: string | null;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.field}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>{label}</Text>
        {optional ? <Text style={styles.optional}>Optional</Text> : null}
      </View>
      {children}
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    padding: spacing.lg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '800',
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 15,
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
    lineHeight: 21,
  },
  statusCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing.md,
    marginTop: spacing.lg,
  },
  statusLabel: {
    color: colors.textMuted,
    fontSize: 13,
  },
  statusValue: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '800',
    marginTop: spacing.xs,
  },
  statusDetail: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: spacing.xs,
  },
  action: {
    marginTop: spacing.md,
  },
  formError: {
    color: colors.danger,
    fontSize: 14,
    marginTop: spacing.md,
  },
  field: {
    marginTop: spacing.lg,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  label: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  optional: {
    color: colors.textMuted,
    fontSize: 12,
    marginLeft: spacing.sm,
  },
  receiptNote: {
    color: colors.textMuted,
    fontSize: 12,
    marginBottom: spacing.sm,
  },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: 16,
    color: colors.text,
  },
  inputError: {
    borderColor: colors.danger,
  },
  fieldError: {
    color: colors.danger,
    fontSize: 13,
    marginTop: spacing.xs,
  },
  emailSaveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
    gap: spacing.sm,
  },
  saveBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    minWidth: 72,
  },
  saveBtnDisabled: {
    opacity: 0.5,
  },
  saveBtnPressed: {
    opacity: 0.8,
  },
  saveBtnText: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: '700',
  },
  savedText: {
    color: colors.textMuted,
    fontSize: 13,
  },
  notice: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: 12,
    backgroundColor: 'rgba(240, 96, 58, 0.10)',
    borderWidth: 1,
    borderColor: colors.primary,
  },
  noticeTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '800',
    marginBottom: spacing.xs,
  },
  noticeText: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
  },
  stateContainer: {
    flex: 1,
    backgroundColor: colors.background,
    padding: spacing.lg,
    justifyContent: 'space-between',
  },
  stateContent: {
    flex: 1,
    justifyContent: 'center',
  },
  stateTitle: {
    color: colors.text,
    fontSize: 24,
    fontWeight: '800',
  },
  stateText: {
    color: colors.textMuted,
    fontSize: 15,
    marginTop: spacing.sm,
    lineHeight: 22,
  },
});
