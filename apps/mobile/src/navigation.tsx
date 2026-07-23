import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ChatScreen } from './screens/ChatScreen';
import { FilesScreen } from './screens/FilesScreen';
import { PairScreen } from './screens/PairScreen';
import { SessionsScreen } from './screens/SessionsScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { theme } from './theme';

export type RootStackParamList = {
  Pair: undefined;
  Main: undefined;
};

export type MainStackParamList = {
  Sessions: undefined;
  Chat: { sessionId?: string } | undefined;
  Files: undefined;
  Settings: undefined;
};

const RootStack = createNativeStackNavigator<RootStackParamList>();
const MainStack = createNativeStackNavigator<MainStackParamList>();

const navTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: theme.colors.primary,
    background: theme.colors.background,
    card: theme.colors.surface,
    text: theme.colors.text,
    border: theme.colors.border,
    notification: theme.colors.purple,
  },
};

function MainNavigator() {
  return (
    <MainStack.Navigator
      initialRouteName="Sessions"
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTintColor: theme.colors.primaryDark,
        headerTitleStyle: { fontWeight: '600', color: theme.colors.text },
        contentStyle: { backgroundColor: theme.colors.background },
      }}
    >
      <MainStack.Screen
        name="Sessions"
        component={SessionsScreen}
        options={{ title: '会话' }}
      />
      <MainStack.Screen
        name="Chat"
        component={ChatScreen}
        options={{ title: '对话' }}
      />
      <MainStack.Screen
        name="Files"
        component={FilesScreen}
        options={{ title: '文件' }}
      />
      <MainStack.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ title: '设置' }}
      />
    </MainStack.Navigator>
  );
}

export type RootNavigatorProps = {
  /** When true, land on Main (has stored device token). Otherwise Pair. */
  hasConnection: boolean;
};

/**
 * Root navigation: Pair | Main (Sessions stack + Chat + Files + Settings).
 * Auth gate only chooses the initial route; full reconnect lives in Task 9.
 */
export function RootNavigator({ hasConnection }: RootNavigatorProps) {
  return (
    <NavigationContainer theme={navTheme}>
      <RootStack.Navigator
        initialRouteName={hasConnection ? 'Main' : 'Pair'}
        screenOptions={{ headerShown: false }}
      >
        <RootStack.Screen name="Pair" component={PairScreen} />
        <RootStack.Screen name="Main" component={MainNavigator} />
      </RootStack.Navigator>
    </NavigationContainer>
  );
}
