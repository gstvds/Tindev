import React, { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';

import { requestOtp, verifyOtp } from '../api/auth';
import { ApiError } from '../api/errors';
import { useAuth } from '../auth/AuthContext';
import { PrimaryButton } from '../components/PrimaryButton';
import { AuthStackParamList } from '../navigation/types';
import { colors, spacing } from '../theme';

type Props = NativeStackScreenProps<AuthStackParamList, 'OtpEntry'>;

const CODE_LENGTH = 6; // matches AuthController.CODE_LENGTH
const DEFAULT_RESEND_COOLDOWN = 60; // matches RESEND_COOLDOWN_MS (60s)

// Present the normalized 234XXXXXXXXXX phone back as +234 XXX XXX XXXX.
function formatPhone(phone: string): string {
  const m = /^234(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return m ? `+234 ${m[1]} ${m[2]} ${m[3]}` : phone;
}

export function OtpEntryScreen({ route }: Props) {
  const { phone } = route.params;
  const { signIn } = useAuth();

  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Seconds until the user may request another code. Seeded to the backend's
  // 60s resend cooldown since a code was just sent to reach this screen.
  const [cooldown, setCooldown] = useState(DEFAULT_RESEND_COOLDOWN);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Single ticking timer that counts the cooldown down to zero.
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setCooldown((c) => (c > 0 ? c - 1 : 0));
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const canVerify = code.length === CODE_LENGTH && !verifying;

  async function onVerify() {
    setError(null);
    if (code.length !== CODE_LENGTH) {
      setError(`Enter the ${CODE_LENGTH}-digit code we sent you.`);
      return;
    }

    setVerifying(true);
    try {
      const result = await verifyOtp(phone, code);
      // Persist tokens to the secure store; flipping auth state swaps the
      // navigator over to the app (Home) stack automatically.
      await signIn({ accessToken: result.accessToken, refreshToken: result.refreshToken });
    } catch (e) {
      const err = e as ApiError;
      // Wrong code (400) may include attemptsLeft; expired code (400) tells the
      // user to request a new one; 429 if they've hammered verify. Show the
      // backend message and append remaining attempts when provided.
      const suffix =
        err.attemptsLeft != null && err.attemptsLeft > 0
          ? ` (${err.attemptsLeft} attempt${err.attemptsLeft === 1 ? '' : 's'} left)`
          : '';
      setError(err.message + suffix);
      setCode('');
    } finally {
      setVerifying(false);
    }
  }

  async function onResend() {
    if (cooldown > 0 || resending) return;
    setError(null);
    setResending(true);
    try {
      await requestOtp(phone);
      setCode('');
      setCooldown(DEFAULT_RESEND_COOLDOWN);
    } catch (e) {
      const err = e as ApiError;
      // On a 429 the backend tells us exactly how long to wait — honor it so the
      // countdown reflects the real server-side cooldown / hourly cap.
      if (err.kind === 'rate_limited' && err.retryAfterSeconds) {
        setCooldown(err.retryAfterSeconds);
      }
      setError(err.message);
    } finally {
      setResending(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.content}>
        <Text style={styles.title}>Enter your code</Text>
        <Text style={styles.subtitle}>
          We sent a {CODE_LENGTH}-digit code to {formatPhone(phone)}.
        </Text>

        <TextInput
          style={styles.input}
          value={code}
          onChangeText={(t) => {
            // Digits only; auto-submit once the full code is entered.
            const digits = t.replace(/\D/g, '').slice(0, CODE_LENGTH);
            setCode(digits);
            if (error) setError(null);
          }}
          placeholder="123456"
          placeholderTextColor={colors.textMuted}
          keyboardType="number-pad"
          autoComplete="sms-otp"
          textContentType="oneTimeCode"
          maxLength={CODE_LENGTH}
          editable={!verifying}
          autoFocus
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable onPress={onResend} disabled={cooldown > 0 || resending} hitSlop={8}>
          <Text style={[styles.resend, cooldown > 0 && styles.resendDisabled]}>
            {resending
              ? 'Sending…'
              : cooldown > 0
                ? `Resend code in ${cooldown}s`
                : 'Resend code'}
          </Text>
        </Pressable>
      </View>

      <PrimaryButton
        title="Verify"
        onPress={onVerify}
        loading={verifying}
        disabled={!canVerify}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    padding: spacing.lg,
    justifyContent: 'space-between',
  },
  content: {
    marginTop: spacing.xl,
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
    marginBottom: spacing.xl,
  },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: 24,
    letterSpacing: 8,
    textAlign: 'center',
    color: colors.text,
  },
  error: {
    color: colors.danger,
    marginTop: spacing.md,
    fontSize: 14,
  },
  resend: {
    color: colors.primary,
    marginTop: spacing.lg,
    fontSize: 15,
    fontWeight: '600',
  },
  resendDisabled: {
    color: colors.textMuted,
  },
});
