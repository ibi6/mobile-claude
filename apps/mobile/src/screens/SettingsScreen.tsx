import { StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';

/**
 * Settings shell: connection status, model, disconnect.
 */
export function SettingsScreen() {
  return (
    <View style={styles.root}>
      <Text style={styles.title}>设置</Text>
      <Text style={styles.body}>
        连接状态、模型快捷设置、自动允许读工具与断开重配对将在后续任务实现。
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.colors.background,
    padding: theme.spacing.lg,
  },
  title: {
    fontSize: theme.fontSize.xl,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: theme.spacing.sm,
  },
  body: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.textSecondary,
    lineHeight: 20,
  },
});
