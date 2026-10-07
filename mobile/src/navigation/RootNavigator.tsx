import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { getMyProfile, isProfileComplete } from '../api/profile';
import { ApiError } from '../api/errors';
import { useAuth } from '../auth/AuthContext';
import { PrimaryButton } from '../components/PrimaryButton';
import { colors, spacing } from '../theme';
import { AppStackParamList, AuthStackParamList } from './types';
import { PhoneEntryScreen } from '../screens/PhoneEntryScreen';
import { OtpEntryScreen } from '../screens/OtpEntryScreen';
import { ProfileSetupScreen } from '../screens/ProfileSetupScreen';
import { PhotoUploadScreen } from '../screens/PhotoUploadScreen';
import { DiscoveryScreen } from '../screens/DiscoveryScreen';
import { DiscoverySettingsScreen } from '../screens/DiscoverySettingsScreen';
import { MatchesScreen } from '../screens/MatchesScreen';
import { ChatScreen } from '../screens/ChatScreen';
import { SubscriptionScreen } from '../screens/SubscriptionScreen';

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const AppStack = createNativeStackNavigator<AppStackParamList>();

// Dark theme so the native container background matches our screens (avoids a
// white flash between transitions).
const navTheme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: colors.background },
};

const screenOptions = {
  headerStyle: { backgroundColor: colors.background },
  headerTintColor: colors.text,
  headerShadowVisible: false,
  contentStyle: { backgroundColor: colors.background },
};

function AuthFlow() {
  return (
    <AuthStack.Navigator screenOptions={screenOptions}>
      <AuthStack.Screen
        name="PhoneEntry"
        component={PhoneEntryScreen}
        options={{ title: 'Sign in' }}
      />
      <AuthStack.Screen
        name="OtpEntry"
        component={OtpEntryScreen}
        options={{ title: 'Verify' }}
      />
    </AuthStack.Navigator>
  );
}

function AppFlow() {
  const { signOut } = useAuth();
  // Resolve where an authenticated user lands by asking the backend about their
  // profile. GET /profile/me drives a three-way onboarding gate — keyed on
  // profile COMPLETENESS, not mere existence, because the photo-upload endpoint
  // upserts a bare (fieldless) profile that would otherwise return 200 and skip
  // setup (see isProfileComplete):
  //   404, or 200 with required fields missing → ProfileSetup
  //   complete but zero photos                 → PhotoUpload (a photoless profile
  //                                              can't be shown in discovery)
  //   complete with at least one photo         → Home
  // Any other failure (network/5xx) is retriable rather than silently dropping
  // the user into the wrong screen.
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [initialRoute, setInitialRoute] = useState<keyof AppStackParamList>('ProfileSetup');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const resolveProfile = useCallback(async () => {
    setStatus('loading');
    try {
      const profile = await getMyProfile();
      if (!isProfileComplete(profile)) {
        // A document exists but the required fields aren't filled (e.g. a bare
        // profile created by a photo upload) — treat it like no profile.
        setInitialRoute('ProfileSetup');
      } else {
        setInitialRoute((profile.photos?.length ?? 0) > 0 ? 'Home' : 'PhotoUpload');
      }
      setStatus('ready');
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 404) {
        // Expected for a brand-new user — route to setup, not an error.
        setInitialRoute('ProfileSetup');
        setStatus('ready');
      } else {
        setErrorMessage(err.message);
        setStatus('error');
      }
    }
  }, []);

  useEffect(() => {
    resolveProfile();
  }, [resolveProfile]);

  if (status === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (status === 'error') {
    return (
      <View style={styles.errorContainer}>
        <View style={styles.errorContent}>
          <Text style={styles.errorTitle}>Couldn’t load your profile</Text>
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
        <PrimaryButton title="Try again" onPress={resolveProfile} />
        <View style={styles.errorSignOut}>
          <PrimaryButton title="Sign out" onPress={signOut} />
        </View>
      </View>
    );
  }

  // All screens live in the stack; the resolved flag only chooses the entry
  // point. ProfileSetup resets to PhotoUpload, which in turn resets to Home, so
  // Back can never return into an earlier onboarding step.
  return (
    <AppStack.Navigator screenOptions={screenOptions} initialRouteName={initialRoute}>
      <AppStack.Screen
        name="ProfileSetup"
        component={ProfileSetupScreen}
        options={{ title: 'Your profile', headerBackVisible: false, gestureEnabled: false }}
      />
      <AppStack.Screen
        name="PhotoUpload"
        component={PhotoUploadScreen}
        options={{ title: 'Add photos', headerBackVisible: false, gestureEnabled: false }}
      />
      <AppStack.Screen
        name="Home"
        component={DiscoveryScreen}
        options={({ navigation }) => ({
          title: 'Discover',
          // Matches list lives to the left; sign-out (which lived on the old Home
          // placeholder) stays on the right now that discovery owns this route.
          headerLeft: () => (
            <Pressable
              onPress={() => navigation.navigate('Matches')}
              hitSlop={8}
              accessibilityRole="button"
            >
              <Text style={styles.headerAction}>Matches</Text>
            </Pressable>
          ),
          // Unlimited icon, then filter icon (left of Sign out) opens discovery
          // settings.
          headerRight: () => (
            <View style={styles.headerRightRow}>
              <Pressable
                onPress={() => navigation.navigate('Subscription')}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Unlimited subscription"
              >
                <Text style={styles.headerIcon}>⭐</Text>
              </Pressable>
              <Pressable
                onPress={() => navigation.navigate('DiscoverySettings')}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Discovery filters"
              >
                <Text style={styles.headerIcon}>⚙</Text>
              </Pressable>
              <Pressable onPress={signOut} hitSlop={8} accessibilityRole="button">
                <Text style={styles.headerAction}>Sign out</Text>
              </Pressable>
            </View>
          ),
        })}
      />
      <AppStack.Screen
        name="DiscoverySettings"
        component={DiscoverySettingsScreen}
        options={{ title: 'Filters' }}
      />
      <AppStack.Screen
        name="Matches"
        component={MatchesScreen}
        options={{ title: 'Matches' }}
      />
      <AppStack.Screen
        name="Chat"
        component={ChatScreen}
        // Title is set from the passed-in name for an instant header, then
        // refreshed by the screen once the conversation resolves.
        options={({ route }) => ({ title: route.params.otherUserName || 'Chat' })}
      />
      <AppStack.Screen
        name="Subscription"
        component={SubscriptionScreen}
        options={{ title: 'Unlimited' }}
      />
    </AppStack.Navigator>
  );
}

export function RootNavigator() {
  const { isAuthenticated, isBootstrapping } = useAuth();

  // While we read tokens from secure storage, show a spinner rather than briefly
  // flashing the phone-entry screen to an already-signed-in user.
  if (isBootstrapping) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  return (
    <NavigationContainer theme={navTheme}>
      {isAuthenticated ? <AppFlow /> : <AuthFlow />}
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  errorContainer: {
    flex: 1,
    backgroundColor: colors.background,
    padding: spacing.lg,
    justifyContent: 'space-between',
  },
  errorContent: {
    flex: 1,
    justifyContent: 'center',
  },
  errorTitle: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '800',
  },
  errorText: {
    color: colors.textMuted,
    fontSize: 15,
    marginTop: spacing.sm,
    lineHeight: 21,
  },
  errorSignOut: {
    marginTop: spacing.md,
  },
  headerAction: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: '700',
  },
  headerRightRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  headerIcon: {
    color: colors.primary,
    fontSize: 18,
    fontWeight: '700',
  },
});
