import { StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';

export type MessageBubbleProps = {
  role: 'user' | 'assistant' | 'system';
  text: string;
  /** Streaming assistant bubble shows a caret hint. */
  streaming?: boolean;
};

/**
 * Chat message bubble — user (right, indigo) / assistant (left, surface) / system.
 */
export function MessageBubble({ role, text, streaming }: MessageBubbleProps) {
  const isUser = role === 'user';
  const isSystem = role === 'system';
  const display = text.length > 0 ? text : streaming ? '…' : '';

  return (
    <View
      style={[
        styles.row,
        isUser ? styles.rowUser : styles.rowOther,
        isSystem && styles.rowSystem,
      ]}
    >
      <View
        style={[
          styles.bubble,
          isUser && styles.bubbleUser,
          role === 'assistant' && styles.bubbleAssistant,
          isSystem && styles.bubbleSystem,
        ]}
      >
        {isSystem ? (
          <Text style={styles.systemLabel}>系统</Text>
        ) : null}
        <Text
          style={[
            styles.text,
            isUser && styles.textUser,
            isSystem && styles.textSystem,
          ]}
          selectable
        >
          {display}
          {streaming && role === 'assistant' ? (
            <Text style={styles.caret}> ▍</Text>
          ) : null}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    marginBottom: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    flexDirection: 'row',
  },
  rowUser: {
    justifyContent: 'flex-end',
  },
  rowOther: {
    justifyContent: 'flex-start',
  },
  rowSystem: {
    justifyContent: 'center',
  },
  bubble: {
    maxWidth: '86%',
    borderRadius: theme.radius.lg,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm + 2,
  },
  bubbleUser: {
    backgroundColor: theme.colors.primaryDark,
    borderBottomRightRadius: theme.radius.sm,
    ...theme.shadow.soft,
  },
  bubbleAssistant: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderBottomLeftRadius: theme.radius.sm,
  },
  bubbleSystem: {
    backgroundColor: theme.colors.surfaceMuted,
    borderRadius: theme.radius.md,
    maxWidth: '94%',
  },
  text: {
    fontSize: theme.fontSize.md,
    lineHeight: 22,
    color: theme.colors.text,
  },
  textUser: {
    color: theme.colors.textInverse,
  },
  textSystem: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.textSecondary,
    textAlign: 'center',
  },
  systemLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: '700',
    color: theme.colors.textMuted,
    marginBottom: 2,
    textAlign: 'center',
  },
  caret: {
    color: theme.colors.primaryLight,
    fontWeight: '700',
  },
});
