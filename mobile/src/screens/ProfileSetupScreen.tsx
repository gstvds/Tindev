import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useHeaderHeight } from '@react-navigation/elements';

import { ApiError } from '../api/errors';
import { Gender, LookingFor, parseFieldErrors, updateMyProfile, UpdateProfileInput } from '../api/profile';
import { PrimaryButton } from '../components/PrimaryButton';
import { AppStackParamList } from '../navigation/types';
import { colors, spacing } from '../theme';

type Props = NativeStackScreenProps<AppStackParamList, 'ProfileSetup'>;

// Opposite-sex matching by product decision: gender is a closed male/female set
// (server-enum validated) and discovery derives the match target from it.
const GENDER_OPTIONS: { value: Gender; label: string }[] = [
  { value: 'female', label: 'Woman' },
  { value: 'male', label: 'Man' },
];

// lookingFor IS enum-validated server-side (casual|serious|marriage|friendship),
// so restricting the UI to these values keeps us from ever sending an invalid one.
const LOOKING_FOR_OPTIONS: { value: LookingFor; label: string }[] = [
  { value: 'serious', label: 'Serious relationship' },
  { value: 'casual', label: 'Casual' },
  { value: 'marriage', label: 'Marriage' },
  { value: 'friendship', label: 'Friendship' },
];

const BIO_MAX = 500;

// Keep only digits and re-insert dashes as YYYY-MM-DD while the user types. Lets
// us take a date without pulling in a native date-picker dependency.
function formatDobInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8); // YYYYMMDD
  const parts = [digits.slice(0, 4), digits.slice(4, 6), digits.slice(6, 8)].filter(Boolean);
  return parts.join('-');
}

// Validate a YYYY-MM-DD string is a real, past calendar date. Returns an error
// message or null. (The backend casts dob to a Date; this just avoids an obvious
// round-trip and gives a clearer message than a raw cast error.)
function validateDob(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return 'Use the format YYYY-MM-DD.';
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  const isRealDate =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  if (!isRealDate) return "That date doesn't exist.";
  if (date.getTime() >= Date.now()) return 'Date of birth must be in the past.';
  return null;
}

export function ProfileSetupScreen({ navigation }: Props) {
  // The screen sits under a native-stack header. Without feeding that header
  // height back to KeyboardAvoidingView, `behavior="padding"` mis-computes the
  // avoided area once the keyboard opens and the ScrollView can't scroll far
  // enough to reach the fields/tags/submit button below the fold.
  const headerHeight = useHeaderHeight();

  const [name, setName] = useState('');
  const [dob, setDob] = useState('');
  const [gender, setGender] = useState<Gender | null>(null);
  const [lookingFor, setLookingFor] = useState<LookingFor | null>(null);
  const [bio, setBio] = useState('');
  const [interests, setInterests] = useState<string[]>([]);
  const [interestDraft, setInterestDraft] = useState('');
  const [stateName, setStateName] = useState('');
  const [lga, setLga] = useState('');

  const [submitting, setSubmitting] = useState(false);
  // Per-field messages keyed by field name; `_form` is the form-level banner.
  const [errors, setErrors] = useState<Record<string, string>>({});

  function setFieldError(field: string, message: string | null) {
    setErrors((prev) => {
      const next = { ...prev };
      if (message) next[field] = message;
      else delete next[field];
      return next;
    });
  }

  function addInterest() {
    const value = interestDraft.trim();
    if (!value) return;
    // De-dupe case-insensitively; keep the user's original casing.
    const exists = interests.some((i) => i.toLowerCase() === value.toLowerCase());
    if (!exists) setInterests((prev) => [...prev, value]);
    setInterestDraft('');
  }

  function removeInterest(value: string) {
    setInterests((prev) => prev.filter((i) => i !== value));
  }

  // Client-side required checks for the core fields. Optional fields (bio,
  // interests, state, lga) are omitted from the payload when blank. Returns true
  // when the form is clean enough to submit.
  function validateLocally(): boolean {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Please enter your name.';
    if (!dob.trim()) next.dob = 'Please enter your date of birth.';
    else {
      const dobError = validateDob(dob.trim());
      if (dobError) next.dob = dobError;
    }
    if (!gender) next.gender = 'Please select an option.';
    if (!lookingFor) next.lookingFor = 'Please select what you’re looking for.';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit() {
    if (submitting) return;
    if (!validateLocally()) return;

    const payload: UpdateProfileInput = {
      name: name.trim(),
      dob: dob.trim(),
      gender: gender ?? undefined,
      lookingFor: lookingFor ?? undefined,
    };
    if (bio.trim()) payload.bio = bio.trim();
    if (interests.length) payload.interests = interests;
    if (stateName.trim()) payload.state = stateName.trim();
    if (lga.trim()) payload.lga = lga.trim();

    setSubmitting(true);
    try {
      await updateMyProfile(payload);
      // Profile now exists — advance to photos. Reset (not push) so Back can't
      // return to setup; the user must add a photo before reaching Home.
      navigation.reset({ index: 0, routes: [{ name: 'PhotoUpload' }] });
    } catch (e) {
      // Map backend validation errors (invalid enum, bad date cast, …) to the
      // relevant field; anything unattributable falls back to the banner.
      const err = e as ApiError;
      if (err.kind === 'validation') {
        setErrors(parseFieldErrors(err));
      } else {
        setErrors({ _form: err.message });
      }
    } finally {
      setSubmitting(false);
    }
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
        <Text style={styles.title}>Set up your profile</Text>
        <Text style={styles.subtitle}>
          Tell people a bit about you. You’ll add photos next; location can come later.
        </Text>

        {errors._form ? <Text style={styles.formError}>{errors._form}</Text> : null}

        {/* Name */}
        <Field label="Name" error={errors.name}>
          <TextInput
            style={[styles.input, !!errors.name && styles.inputError]}
            value={name}
            onChangeText={(t) => {
              setName(t);
              if (errors.name) setFieldError('name', null);
            }}
            placeholder="Your name"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="words"
            editable={!submitting}
          />
        </Field>

        {/* Date of birth */}
        <Field label="Date of birth" error={errors.dob} hint="YYYY-MM-DD">
          <TextInput
            style={[styles.input, !!errors.dob && styles.inputError]}
            value={dob}
            onChangeText={(t) => {
              setDob(formatDobInput(t));
              if (errors.dob) setFieldError('dob', null);
            }}
            placeholder="1995-06-15"
            placeholderTextColor={colors.textMuted}
            keyboardType="number-pad"
            maxLength={10}
            editable={!submitting}
          />
        </Field>

        {/* Gender */}
        <Field label="Gender" error={errors.gender}>
          <ChipGroup
            options={GENDER_OPTIONS}
            selected={gender}
            onSelect={(v) => {
              setGender(v);
              if (errors.gender) setFieldError('gender', null);
            }}
            disabled={submitting}
          />
        </Field>

        {/* Looking for */}
        <Field label="Looking for" error={errors.lookingFor}>
          <ChipGroup
            options={LOOKING_FOR_OPTIONS}
            selected={lookingFor}
            onSelect={(v) => {
              setLookingFor(v as LookingFor);
              if (errors.lookingFor) setFieldError('lookingFor', null);
            }}
            disabled={submitting}
          />
        </Field>

        {/* Bio */}
        <Field label="Bio" error={errors.bio} optional>
          <TextInput
            style={[styles.input, styles.multiline, !!errors.bio && styles.inputError]}
            value={bio}
            onChangeText={(t) => {
              setBio(t.slice(0, BIO_MAX));
              if (errors.bio) setFieldError('bio', null);
            }}
            placeholder="A little about you…"
            placeholderTextColor={colors.textMuted}
            multiline
            numberOfLines={4}
            maxLength={BIO_MAX}
            editable={!submitting}
          />
          <Text style={styles.counter}>
            {bio.length}/{BIO_MAX}
          </Text>
        </Field>

        {/* Interests */}
        <Field label="Interests" error={errors.interests} optional>
          <View style={styles.interestRow}>
            <TextInput
              style={[styles.input, styles.interestInput]}
              value={interestDraft}
              onChangeText={setInterestDraft}
              placeholder="e.g. Afrobeats"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              returnKeyType="done"
              onSubmitEditing={addInterest}
              editable={!submitting}
            />
            <Pressable
              onPress={addInterest}
              disabled={submitting || !interestDraft.trim()}
              style={({ pressed }) => [
                styles.addBtn,
                (submitting || !interestDraft.trim()) && styles.addBtnDisabled,
                pressed && styles.chipPressed,
              ]}
            >
              <Text style={styles.addBtnText}>Add</Text>
            </Pressable>
          </View>
          {interests.length > 0 ? (
            <View style={styles.tagWrap}>
              {interests.map((interest) => (
                <Pressable
                  key={interest}
                  onPress={() => removeInterest(interest)}
                  disabled={submitting}
                  style={styles.tag}
                >
                  <Text style={styles.tagText}>{interest}</Text>
                  <Text style={styles.tagRemove}>×</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </Field>

        {/* State */}
        <Field label="State" error={errors.state} optional>
          <TextInput
            style={[styles.input, !!errors.state && styles.inputError]}
            value={stateName}
            onChangeText={(t) => {
              setStateName(t);
              if (errors.state) setFieldError('state', null);
            }}
            placeholder="e.g. Lagos"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="words"
            editable={!submitting}
          />
        </Field>

        {/* LGA */}
        <Field label="LGA" error={errors.lga} optional>
          <TextInput
            style={[styles.input, !!errors.lga && styles.inputError]}
            value={lga}
            onChangeText={(t) => {
              setLga(t);
              if (errors.lga) setFieldError('lga', null);
            }}
            placeholder="e.g. Ikeja"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="words"
            editable={!submitting}
          />
        </Field>

        <View style={styles.submit}>
          <PrimaryButton title="Save profile" onPress={onSubmit} loading={submitting} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// A labelled form row with an optional hint and an inline error message.
function Field({
  label,
  error,
  hint,
  optional,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.field}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>{label}</Text>
        {optional ? <Text style={styles.optional}>Optional</Text> : null}
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      {children}
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
    </View>
  );
}

// Single-select chip group. Generic over the option value type.
function ChipGroup<T extends string>({
  options,
  selected,
  onSelect,
  disabled,
}: {
  options: { value: T; label: string }[];
  selected: T | null;
  onSelect: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.chipGroup}>
      {options.map((opt) => {
        const active = selected === opt.value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onSelect(opt.value)}
            disabled={disabled}
            style={({ pressed }) => [
              styles.chip,
              active && styles.chipActive,
              pressed && styles.chipPressed,
            ]}
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]}>{opt.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
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
  optional: {
    color: colors.textMuted,
    fontSize: 12,
    marginLeft: spacing.sm,
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
  multiline: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
  counter: {
    color: colors.textMuted,
    fontSize: 12,
    alignSelf: 'flex-end',
    marginTop: spacing.xs,
  },
  fieldError: {
    color: colors.danger,
    fontSize: 13,
    marginTop: spacing.xs,
  },
  chipGroup: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
  },
  chipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipPressed: {
    opacity: 0.8,
  },
  chipText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  chipTextActive: {
    color: colors.text,
  },
  interestRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  interestInput: {
    flex: 1,
  },
  addBtn: {
    paddingHorizontal: spacing.lg,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  addBtnDisabled: {
    opacity: 0.5,
  },
  addBtnText: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: '700',
  },
  tagWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    paddingVertical: spacing.xs,
  },
  tagText: {
    color: colors.text,
    fontSize: 14,
  },
  tagRemove: {
    color: colors.textMuted,
    fontSize: 18,
    marginLeft: spacing.xs,
    fontWeight: '700',
  },
  submit: {
    marginTop: spacing.sm,
  },
});
