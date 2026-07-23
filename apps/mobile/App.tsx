import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RootNavigator } from './src/navigation';
import { loadConnection } from './src/storage/secure';
import { theme } from './src/theme';

/**
 * App entry: hydrate secure connection, then mount navigation shells.
 * WebSocket client is intentionally out of scope (Task 9).
 */
export default function App() {
  const [ready, setReady] = useState(false);
  const [hasConnection, setHasConnection] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const connection = await loadConnection();
        if (!cancelled) {
          setHasConnection(connection !== null);
        }
      } catch {
        if (!cancelled) {
          setHasConnection(false);
        }
      } finally {
        if (!cancelled) {
          setReady(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return (
      <View style={styles.boot}>
        <StatusBar style="dark" />
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <RootNavigator hasConnection={hasConnection} />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  boot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.background,
  },
});
