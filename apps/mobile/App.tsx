import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RootNavigator } from './src/navigation';
import { ConnectionProvider, useConnection } from './src/state/connection';
import { SessionsProvider } from './src/state/sessions';
import { theme } from './src/theme';

/**
 * App entry: ConnectionProvider hydrates SecureStore + WS client,
 * then mounts navigation (Pair | Main) with session list state.
 */
export default function App() {
  return (
    <SafeAreaProvider>
      <ConnectionProvider>
        <SessionsProvider>
          <AppReady />
        </SessionsProvider>
      </ConnectionProvider>
    </SafeAreaProvider>
  );
}

function AppReady() {
  const { ready, hasConnection } = useConnection();

  if (!ready) {
    return (
      <View style={styles.boot}>
        <StatusBar style="dark" />
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  return (
    <>
      <StatusBar style="dark" />
      <RootNavigator hasConnection={hasConnection} />
    </>
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
