import { StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';

/**
 * Workspace file browser shell.
 */
export function FilesScreen() {
  return (
    <View style={styles.root}>
      <Text style={styles.title}>文件</Text>
      <Text style={styles.body}>
        工作区目录树与文本预览将在后续任务接入。当前仅导航壳层。
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
