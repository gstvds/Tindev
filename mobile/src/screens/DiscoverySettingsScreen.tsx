import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useHeaderHeight } from '@react-navigation/elements';

import { ApiError } from '../api/errors';
import { getMyProfile, updateDiscoverySettings } from '../api/profile';
import { PrimaryButton } from '../components/PrimaryButton';
import { AppStackParamList } from '../navigation/types';
import { colors, spacing } from '../theme';

type Props = NativeStackScreenProps<AppStackParamList, 'DiscoverySettings'>;

// Fallbacks used when a profile has never set these (the backend defaults
// maxDistanceKm to 25 but leaves ageRange unset). Kept in sync with the schema.
const DEFAULT_DISTANCE = 25;
const DEFAULT_AGE_MIN = 18;
const DEFAULT_AGE_MAX = 60;
const AGE_FLOOR = 18; // backend rejects ageRange.min below this

// Shown when the backend refuses to enable the NIN-only filter (403
// NIN_REQUIRED). Deliberately does NOT link anywhere: NIN verification has no
// screen on mobile yet, so we explain the requirement rather than dead-ending
// the user at a route that doesn't exist.
const NIN_REQUIRED_MESSAGE =
  'To only see NIN-verified people, your own NIN has to be verified first. ' +
  'NIN verification isn’t available in the app yet — it’s coming soon. Until ' +
  'then this filter stays off.';

type Screen = 'loading' | 'ready' | 'error';

export function DiscoverySettingsScreen({ navigation }: Props) {
  const headerHeight = useHeaderHeight();

  const [screen, setScreen] = useState<Screen>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);

  // Form state. Numeric fields are kept as strings so the inputs can be edited
  // freely (including transient empties); parsed only at validate/save time.
  const [ninOnly, setNinOnly] = useState(false);
  const [distance, setDistance] = useState(String(DEFAULT_DISTANCE));
  const [ageMin, setAgeMin] = useState(String(DEFAULT_AGE_MIN));
  const [ageMax, setAgeMax] = useState(String(DEFAULT_AGE_MAX));

  const [submitting, setSubmitting] = useState(false);
  // Per-field messages (`distance`, `ageRange`) plus `_form` for anything
  // unattributable. The NIN requirement gets its own notice, not an error.
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [ninNotice, setNinNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setScreen('loading');
    setLoadError(null);
    try {
      const profile = await getMyProfile();
      const ds = profile.discoverySettings;
      setNinOnly(ds?.showOnlyNinVerified ?? false);
      setDistance(String(ds?.maxDistanceKm ?? DEFAULT_DISTANCE));
      setAgeMin(String(ds?.ageRange?.min ?? DEFAULT_AGE_MIN));
      setAgeMax(String(ds?.ageRange?.max ?? DEFAULT_AGE_MAX));
      setScreen('ready');
    } catch (e) {
      const err = e as ApiError;
      // A 404 (no profile doc) shouldn't happen from Discover, but if it does we
      // still let the user set filters from defaults rather than dead-ending.
      if (err.status === 404) {
        setScreen('ready');
      } else {
        setLoadError(err.message);
        setScreen('error');
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function setFieldError(field: string, message: string | null) {
    setErrors((prev) => {
      const next = { ...prev };
      if (message) next[field] = message;
      else delete next[field];
      return next;
    });
  }

  // Mirror the backend's checks so the user gets an inline message before the
  // round-trip. Returns true when the form is safe to submit.
  function validateLocally(): boolean {
    const next: Record<string, string> = {};

    const dist = Number(distance);
    if (!distance.trim() || !Number.isFinite(dist) || dist <= 0) {
      next.distance = 'Enter a maximum distance greater than 0 km.';
    }

    const min = Number(ageMin);
    const max = Number(ageMax);
    if (!ageMin.trim() || !Number.isFinite(min) || !ageMax.trim() || !Number.isFinite(max)) {
      next.ageRange = 'Enter both a minimum and maximum age.';
    } else if (min < AGE_FLOOR) {
      next.ageRange = `Minimum age must be at least ${AGE_FLOOR}.`;
    } else if (min > max) {
      next.ageRange = 'Minimum age can’t be greater than the maximum.';
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSave() {
    if (submitting) return;
    if (!validateLocally()) return;

    setSubmitting(true);
    setNinNotice(null);
    try {
      await updateDiscoverySettings({
        showOnlyNinVerified: ninOnly,
        maxDistanceKm: Number(distance),
        ageRange: { min: Number(ageMin), max: Number(ageMax) },
      });
      // Saved. Pop back to Discover. (The open deck won't re-query until it's
      // reloaded/refreshed — a known limitation of this slice.)
      navigation.goBack();
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 403 && err.code === 'NIN_REQUIRED') {
        // The backend persisted nothing and won't accept the NIN filter. Flip
        // the toggle back off (it didn't take effect) and explain why, so a
        // follow-up Save can still persist the distance/age changes.
        setNinOnly(false);
        setNinNotice(NIN_REQUIRED_MESSAGE);
      } else {
        setErrors({ _form: err.message });
      }
    } finally {
      setSubmitting(false);
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
          <Text style={styles.stateTitle}>Couldn’t load your filters</Text>
          <Text style={styles.stateText}>{loadError}</Text>
        </View>
        <PrimaryButton title="Try again" onPress={() => void load()} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={headerHeight}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>Discovery filters</Text>
        <Text style={styles.subtitle}>
          Choose who shows up in your deck. These apply the next time your deck loads.
        </Text>

        {errors._form ? <Text style={styles.formError}>{errors._form}</Text> : null}

        {/* NIN-only toggle */}
        <View style={styles.field}>
          <View style={styles.toggleRow}>
            <View style={styles.toggleText}>
              <Text style={styles.label}>Only NIN-verified people</Text>
              <Text style={styles.helper}>
                Show only people who’ve verified their National ID.
              </Text>
            </View>
            <Switch
              value={ninOnly}
              onValueChange={(v) => {
                setNinOnly(v);
                // Clear a stale requirement notice when they toggle off.
                if (!v) setNinNotice(null);
              }}
              disabled={submitting}
              trackColor={{ false: colors.border, true: colors.primary }}
              thumbColor={colors.text}
            />
          </View>
          {ninNotice ? (
            <View style={styles.notice}>
              <Text style={styles.noticeTitle}>NIN verification required</Text>
              <Text style={styles.noticeText}>{ninNotice}</Text>
            </View>
          ) : null}
        </View>

        {/* Max distance */}
        <View style={styles.field}>
          <View style={styles.labelRow}>
            <Text style={styles.label}>Maximum distance</Text>
            <Text style={styles.hint}>km</Text>
          </View>
          <TextInput
            style={[styles.input, !!errors.distance && styles.inputError]}
            value={distance}
            onChangeText={(t) => {
              setDistance(t.replace(/[^0-9]/g, ''));
              if (errors.distance) setFieldError('distance', null);
            }}
            placeholder={String(DEFAULT_DISTANCE)}
            placeholderTextColor={colors.textMuted}
            keyboardType="number-pad"
            maxLength={4}
            editable={!submitting}
          />
          {errors.distance ? <Text style={styles.fieldError}>{errors.distance}</Text> : null}
        </View>

        {/* Age range */}
        <View style={styles.field}>
          <View style={styles.labelRow}>
            <Text style={styles.label}>Age range</Text>
            <Text style={styles.hint}>{AGE_FLOOR}+</Text>
          </View>
          <View style={styles.ageRow}>
            <TextInput
              style={[styles.input, styles.ageInput, !!errors.ageRange && styles.inputError]}
              value={ageMin}
              onChangeText={(t) => {
                setAgeMin(t.replace(/[^0-9]/g, ''));
                if (errors.ageRange) setFieldError('ageRange', null);
              }}
              placeholder="Min"
              placeholderTextColor={colors.textMuted}
              keyboardType="number-pad"
              maxLength={3}
              editable={!submitting}
              accessibilityLabel="Minimum age"
            />
            <Text style={styles.ageDash}>–</Text>
            <TextInput
              style={[styles.input, styles.ageInput, !!errors.ageRange && styles.inputError]}
              value={ageMax}
              onChangeText={(t) => {
                setAgeMax(t.replace(/[^0-9]/g, ''));
                if (errors.ageRange) setFieldError('ageRange', null);
              }}
              placeholder="Max"
              placeholderTextColor={colors.textMuted}
              keyboardType="number-pad"
              maxLength={3}
              editable={!submitting}
              accessibilityLabel="Maximum age"
            />
          </View>
          {errors.ageRange ? <Text style={styles.fieldError}>{errors.ageRange}</Text> : null}
        </View>

        <View style={styles.submit}>
          <PrimaryButton title="Save filters" onPress={onSave} loading={submitting} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  scroll: {
    padding: spacing.lg,
    paddingBottom: spacing.xl,
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
  },
  formError: {
    color: colors.danger,
    fontSize: 14,
    marginBottom: spacing.md,
  },
  field: {
    marginBottom: spacing.lg,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  toggleText: {
    flex: 1,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  label: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  helper: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: spacing.xs,
    lineHeight: 18,
  },
  hint: {
    color: colors.textMuted,
    fontSize: 12,
    marginLeft: spacing.sm,
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
  ageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  ageInput: {
    flex: 1,
    textAlign: 'center',
  },
  ageDash: {
    color: colors.textMuted,
    fontSize: 18,
    fontWeight: '700',
  },
  fieldError: {
    color: colors.danger,
    fontSize: 13,
    marginTop: spacing.xs,
  },
  // Informational (not error) notice for the NIN requirement — primary-tinted
  // so it reads as guidance rather than a validation failure.
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
  submit: {
    marginTop: spacing.sm,
  },
});
