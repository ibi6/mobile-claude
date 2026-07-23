import { StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';

/**
 * Chat shell. Streaming + tool cards in later tasks.
 */
export function ChatScreen() {
  return (
    <View style={styles.root}>
      <Text style={styles.title}>对话</Text>
      <Text style={styles.body}>
        消息流、工具卡片与输入框将在后续任务实现。请确保 Agent 守护进程已在电脑端运行。
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
