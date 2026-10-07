import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as ImagePicker from 'expo-image-picker';

import { ApiError } from '../api/errors';
import {
  deleteProfilePhoto,
  PhotoUpload,
  Profile,
  uploadProfilePhoto,
} from '../api/profile';
import { PrimaryButton } from '../components/PrimaryButton';
import { AppStackParamList } from '../navigation/types';
import { colors, spacing } from '../theme';

type Props = NativeStackScreenProps<AppStackParamList, 'PhotoUpload'>;

// Mirror the backend cap (MAX_PHOTOS in ProfileController). The server enforces
// it too — this just stops us from offering slots that would 409.
const MAX_PHOTOS = 6;
const COLUMNS = 3;

// One tile in the grid. `pending` photos haven't been sent yet; `uploading`/
// `deleting` are in flight; `uploaded` carry the server `photoId` (needed to
// delete) and the server's `isPrimary`; `error` keeps the local file so the user
// can retry without re-picking. `uri` is the local file until upload swaps in the
// remote URL.
type PhotoStatus = 'pending' | 'uploading' | 'uploaded' | 'error' | 'deleting';
type PhotoItem = {
  id: string;
  uri: string;
  name: string;
  type: string;
  status: PhotoStatus;
  photoId?: string;
  isPrimary: boolean;
  error?: string;
};

// Best-effort MIME type from a filename, for when the picker doesn't give one.
// The backend only checks the multipart part's type starts with "image/".
function mimeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'heic':
      return 'image/heic';
    case 'heif':
      return 'image/heif';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    default:
      return 'image/jpeg';
  }
}

export function PhotoUploadScreen({ navigation }: Props) {
  const { width } = useWindowDimensions();
  const tileSize = (width - spacing.lg * 2 - spacing.sm * (COLUMNS - 1)) / COLUMNS;

  // items is mirrored into a ref so the serial upload queue can read the latest
  // list synchronously (state updates are async and the queue loops over them).
  const [items, setItemsState] = useState<PhotoItem[]>([]);
  const itemsRef = useRef<PhotoItem[]>([]);
  const setItems = (updater: (prev: PhotoItem[]) => PhotoItem[]) => {
    setItemsState((prev) => {
      const next = updater(prev);
      itemsRef.current = next;
      return next;
    });
  };

  // Guards the queue so only one upload is in flight at a time (primary is
  // decided by array position server-side; serial keeps "first chosen = primary"
  // and avoids two photos both landing as primary).
  const processingRef = useRef(false);
  const idCounter = useRef(0);
  const nextId = () => `p${idCounter.current++}`;

  const uploadedCount = items.filter((i) => i.status === 'uploaded').length;
  const busy = items.some((i) => i.status === 'uploading' || i.status === 'deleting');
  const remaining = MAX_PHOTOS - items.length;

  // Reflect each server photo's isPrimary onto its local item. Called after every
  // upload and delete because deleting the primary promotes another photo.
  function reconcile(profile: Profile) {
    const byId = new Map((profile.photos ?? []).map((p) => [p._id, p] as const));
    setItems((prev) =>
      prev.map((i) => (i.photoId && byId.has(i.photoId) ? { ...i, isPrimary: byId.get(i.photoId)!.isPrimary } : i)),
    );
  }

  async function uploadOne(id: string) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, status: 'uploading', error: undefined } : i)));
    const item = itemsRef.current.find((i) => i.id === id);
    if (!item) return;

    const file: PhotoUpload = { uri: item.uri, name: item.name, type: item.type };
    try {
      const profile = await uploadProfilePhoto(file);
      // We upload serially and the backend appends, so the photo we just created
      // is the last one on the returned profile.
      const created = profile.photos?.[profile.photos.length - 1];
      setItems((prev) =>
        prev.map((i) =>
          i.id === id
            ? {
                ...i,
                status: 'uploaded',
                photoId: created?._id,
                isPrimary: created?.isPrimary ?? i.isPrimary,
                uri: created?.url ?? i.uri,
              }
            : i,
        ),
      );
      reconcile(profile);
    } catch (e) {
      // A single failure must not lose the other selections — mark just this one
      // and leave the rest untouched so the queue can carry on.
      const err = e as ApiError;
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, status: 'error', error: err.message } : i)));
    }
  }

  // Drain every pending item one at a time. Re-entrant-safe via processingRef, so
  // adding more photos mid-run just extends the same queue.
  async function processQueue() {
    if (processingRef.current) return;
    processingRef.current = true;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const next = itemsRef.current.find((i) => i.status === 'pending');
        if (!next) break;
        await uploadOne(next.id);
      }
    } finally {
      processingRef.current = false;
    }
  }

  function addAssets(assets: ImagePicker.ImagePickerAsset[]) {
    const slots = MAX_PHOTOS - itemsRef.current.length;
    if (slots <= 0) return;
    const picked = assets.slice(0, slots).map<PhotoItem>((asset) => {
      const name = asset.fileName ?? asset.uri.split('/').pop() ?? `${nextId()}.jpg`;
      return {
        id: nextId(),
        uri: asset.uri,
        name,
        type: asset.mimeType ?? mimeFromName(name),
        status: 'pending',
        isPrimary: false,
      };
    });
    setItems((prev) => [...prev, ...picked]);
    // Fire-and-forget: the queue reads itemsRef, which we just updated.
    void processQueue();
  }

  async function pickFromLibrary() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        'Photos permission needed',
        'Enable photo library access in Settings to add photos to your profile.',
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      selectionLimit: Math.max(1, MAX_PHOTOS - itemsRef.current.length),
      quality: 0.8,
    });
    if (!result.canceled) addAssets(result.assets);
  }

  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Camera permission needed', 'Enable camera access in Settings to take a profile photo.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
    });
    if (!result.canceled) addAssets(result.assets);
  }

  function onAddPress() {
    if (remaining <= 0) return;
    // No third-party action sheet — a native Alert with buttons covers both
    // sources without adding a dependency.
    Alert.alert('Add a photo', undefined, [
      { text: 'Photo Library', onPress: () => void pickFromLibrary() },
      { text: 'Take Photo', onPress: () => void takePhoto() },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  function retry(id: string) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, status: 'pending', error: undefined } : i)));
    void processQueue();
  }

  async function remove(item: PhotoItem) {
    // Uploaded photos live on the server — delete there and reconcile (which may
    // promote a new primary). Not-yet-uploaded selections are only local.
    if (item.status === 'uploaded' && item.photoId) {
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, status: 'deleting' } : i)));
      try {
        const profile = await deleteProfilePhoto(item.photoId);
        setItems((prev) => prev.filter((i) => i.id !== item.id));
        reconcile(profile);
      } catch (e) {
        const err = e as ApiError;
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, status: 'uploaded' } : i)));
        Alert.alert('Couldn’t remove photo', err.message);
      }
      return;
    }
    setItems((prev) => prev.filter((i) => i.id !== item.id));
  }

  function onContinue() {
    if (uploadedCount === 0 || busy) return;
    navigation.reset({ index: 0, routes: [{ name: 'Home' }] });
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Add your photos</Text>
        <Text style={styles.subtitle}>
          Add at least one photo so you can be seen in discovery. Your first photo is your main one.
          You can add up to {MAX_PHOTOS}.
        </Text>

        <View style={styles.grid}>
          {items.map((item) => (
            <PhotoTile key={item.id} item={item} size={tileSize} onRemove={() => void remove(item)} onRetry={() => retry(item.id)} />
          ))}

          {remaining > 0 ? (
            <Pressable
              onPress={onAddPress}
              style={({ pressed }) => [
                styles.tile,
                styles.addTile,
                { width: tileSize, height: tileSize },
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.addPlus}>＋</Text>
              <Text style={styles.addLabel}>Add photo</Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <Text style={styles.footerHint}>
          {uploadedCount === 0
            ? 'Add at least one photo to continue.'
            : `${uploadedCount} photo${uploadedCount === 1 ? '' : 's'} added.`}
        </Text>
        <PrimaryButton title="Continue" onPress={onContinue} disabled={uploadedCount === 0} loading={busy} />
      </View>
    </View>
  );
}

// A single grid cell: the image with a status overlay (spinner while in flight,
// a retry surface on failure), a remove button, and a primary badge.
function PhotoTile({
  item,
  size,
  onRemove,
  onRetry,
}: {
  item: PhotoItem;
  size: number;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const inFlight = item.status === 'uploading' || item.status === 'deleting';
  const showRemove = item.status !== 'uploading' && item.status !== 'deleting';

  return (
    <View style={[styles.tile, { width: size, height: size }]}>
      <Image source={{ uri: item.uri }} style={styles.image} />

      {inFlight ? (
        <View style={styles.overlay}>
          <ActivityIndicator color={colors.text} />
        </View>
      ) : null}

      {item.status === 'error' ? (
        <Pressable onPress={onRetry} style={[styles.overlay, styles.errorOverlay]}>
          <Text style={styles.errorText}>Upload failed</Text>
          <Text style={styles.retryText}>Tap to retry</Text>
        </Pressable>
      ) : null}

      {item.isPrimary && item.status === 'uploaded' ? (
        <View style={styles.primaryBadge}>
          <Text style={styles.primaryBadgeText}>Main</Text>
        </View>
      ) : null}

      {showRemove ? (
        <Pressable
          onPress={onRemove}
          hitSlop={8}
          style={({ pressed }) => [styles.removeBtn, pressed && styles.pressed]}
          accessibilityLabel="Remove photo"
        >
          <Text style={styles.removeText}>×</Text>
        </Pressable>
      ) : null}
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
    lineHeight: 21,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  tile: {
    borderRadius: 12,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  addTile: {
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addPlus: {
    color: colors.primary,
    fontSize: 28,
    fontWeight: '700',
    lineHeight: 30,
  },
  addLabel: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: spacing.xs,
  },
  pressed: {
    opacity: 0.8,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(11, 18, 32, 0.55)',
  },
  errorOverlay: {
    backgroundColor: 'rgba(11, 18, 32, 0.78)',
    padding: spacing.xs,
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
  },
  retryText: {
    color: colors.text,
    fontSize: 12,
    marginTop: spacing.xs,
    textAlign: 'center',
  },
  primaryBadge: {
    position: 'absolute',
    left: spacing.xs,
    bottom: spacing.xs,
    backgroundColor: colors.primary,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  primaryBadgeText: {
    color: colors.text,
    fontSize: 11,
    fontWeight: '800',
  },
  removeBtn: {
    position: 'absolute',
    top: spacing.xs,
    right: spacing.xs,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(11, 18, 32, 0.75)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeText: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 20,
  },
  footer: {
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  footerHint: {
    color: colors.textMuted,
    fontSize: 13,
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
});
