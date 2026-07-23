import { Pressable, StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';

export type ToolCardProps = {
  name: string;
  inputSummary: string;
  /** running | ok | error | denied | aborted | … */
  status: string;
  outputSummary?: string;
  /** When set, shows a "查看 Diff" chip that calls this. */
  onOpenDiff?: () => void;
};

function statusStyle(status: string): {
  label: string;
  color: string;
  bg: string;
} {
  const s = status.toLowerCase();
  if (s === 'running' || s === 'started' || s === 'in_progress') {
    return {
      label: '运行中',
      color: theme.colors.warning,
      bg: theme.colors.warningSoft,
    };
  }
  if (s === 'ok' || s === 'success' || s === 'completed' || s === 'done') {
    return {
      label: '完成',
      color: theme.colors.success,
      bg: theme.colors.successSoft,
    };
  }
  if (s === 'denied') {
    return {
      label: '已拒绝',
      color: theme.colors.danger,
      bg: theme.colors.dangerSoft,
    };
  }
  if (s === 'aborted' || s === 'cancelled' || s === 'canceled') {
    return {
      label: '已中止',
      color: theme.colors.textSecondary,
      bg: theme.colors.surfaceMuted,
    };
  }
  if (s === 'error' || s === 'failed') {
    return {
      label: '失败',
      color: theme.colors.danger,
      bg: theme.colors.dangerSoft,
    };
  }
  return {
    label: status || '未知',
    color: theme.colors.textSecondary,
    bg: theme.colors.surfaceMuted,
  };
}

/**
 * Tool run card in the chat timeline (started → completed).
 */
export function ToolCard({
  name,
  inputSummary,
  status,
  outputSummary,
  onOpenDiff,
}: ToolCardProps) {
  const badge = statusStyle(status);
  const running =
    status.toLowerCase() === 'running' ||
    status.toLowerCase() === 'started' ||
    status.toLowerCase() === 'in_progress';

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.nameRow}>
          <View style={styles.iconDot} />
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
        </View>
        <View style={[styles.badge, { backgroundColor: badge.bg }]}>
          <Text style={[styles.badgeText, { color: badge.color }]}>
            {badge.label}
          </Text>
        </View>
      </View>
      {inputSummary ? (
        <Text style={styles.summary} numberOfLines={3}>
          {inputSummary}
        </Text>
      ) : null}
      {outputSummary && !running ? (
        <Text style={styles.output} numberOfLines={4}>
          {outputSummary}
        </Text>
      ) : null}
      {onOpenDiff ? (
        <Pressable
          onPress={onOpenDiff}
          style={({ pressed }) => [
            styles.diffChip,
            pressed && styles.diffChipPressed,
          ]}
          accessibilityLabel="查看 Diff"
        >
          <Text style={styles.diffChipText}>查看 Diff</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.purple,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.xs,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
    gap: theme.spacing.sm,
  },
  iconDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.purple,
  },
  name: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: '700',
    color: theme.colors.text,
    fontFamily: 'monospace',
  },
  badge: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
    borderRadius: theme.radius.full,
  },
  badgeText: {
    fontSize: theme.fontSize.xs,
    fontWeight: '700',
  },
  summary: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.textSecondary,
    lineHeight: 18,
  },
  output: {
    marginTop: theme.spacing.xs,
    fontSize: theme.fontSize.xs,
    color: theme.colors.textMuted,
    lineHeight: 18,
    fontFamily: 'monospace',
  },
  diffChip: {
    alignSelf: 'flex-start',
    marginTop: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs + 2,
    borderRadius: theme.radius.full,
    backgroundColor: '#EEF2FF',
    borderWidth: 1,
    borderColor: theme.colors.primaryLight,
  },
  diffChipPressed: {
    opacity: 0.8,
  },
  diffChipText: {
    fontSize: theme.fontSize.xs,
    fontWeight: '700',
    color: theme.colors.primaryDark,
  },
});
