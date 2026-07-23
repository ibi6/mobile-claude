import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { PermissionDecision, RiskLevel } from '@mobile-claude/protocol';
import { theme } from '../theme';

export type PermissionSheetProps = {
  visible: boolean;
  toolName: string;
  risk: RiskLevel;
  input: unknown;
  /** While true, backdrop cannot dismiss and buttons are disabled after press. */
  responding?: boolean;
  onRespond: (decision: PermissionDecision) => void;
};

function riskMeta(risk: RiskLevel): { label: string; color: string; bg: string } {
  switch (risk) {
    case 'high':
      return {
        label: '高风险',
        color: theme.colors.danger,
        bg: theme.colors.dangerSoft,
      };
    case 'medium':
      return {
        label: '中风险',
        color: theme.colors.warning,
        bg: theme.colors.warningSoft,
      };
    case 'low':
    default:
      return {
        label: '低风险',
        color: theme.colors.success,
        bg: theme.colors.successSoft,
      };
  }
}

function formatInput(input: unknown): string {
  if (input === null || input === undefined) return '（无参数）';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/**
 * Bottom-sheet style modal for tool permission decisions.
 * Not dismissible by backdrop while a request is pending.
 */
export function PermissionSheet({
  visible,
  toolName,
  risk,
  input,
  responding = false,
  onRespond,
}: PermissionSheetProps) {
  const badge = riskMeta(risk);
  const inputText = formatInput(input);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={() => {
        // Hardware back must not silently drop a pending permission.
        // User must explicitly deny.
      }}
    >
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.title}>需要授权</Text>
          <Text style={styles.subtitle}>Agent 请求执行以下工具</Text>

          <View style={styles.metaRow}>
            <Text style={styles.toolName} numberOfLines={1}>
              {toolName}
            </Text>
            <View style={[styles.riskBadge, { backgroundColor: badge.bg }]}>
              <Text style={[styles.riskText, { color: badge.color }]}>
                {badge.label}
              </Text>
            </View>
          </View>

          <ScrollView
            style={styles.inputScroll}
            contentContainerStyle={styles.inputContent}
            nestedScrollEnabled
          >
            <Text style={styles.inputLabel}>参数</Text>
            <Text style={styles.inputBody} selectable>
              {inputText}
            </Text>
          </ScrollView>

          <View style={styles.actions}>
            <Pressable
              style={({ pressed }) => [
                styles.btn,
                styles.btnDeny,
                (responding || pressed) && styles.btnPressed,
              ]}
              disabled={responding}
              onPress={() => onRespond('deny')}
              accessibilityLabel="拒绝"
            >
              <Text style={styles.btnDenyText}>拒绝</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.btn,
                styles.btnOnce,
                (responding || pressed) && styles.btnPressed,
              ]}
              disabled={responding}
              onPress={() => onRespond('allow_once')}
              accessibilityLabel="允许一次"
            >
              {responding ? (
                <ActivityIndicator color={theme.colors.textInverse} size="small" />
              ) : (
                <Text style={styles.btnOnceText}>允许一次</Text>
              )}
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.btn,
                styles.btnSession,
                (responding || pressed) && styles.btnPressed,
              ]}
              disabled={responding}
              onPress={() => onRespond('allow_session')}
              accessibilityLabel="本会话允许"
            >
              <Text style={styles.btnSessionText}>本会话允许</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: theme.colors.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.xl,
    maxHeight: '78%',
    ...theme.shadow.soft,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.border,
    marginBottom: theme.spacing.md,
  },
  title: {
    fontSize: theme.fontSize.xl,
    fontWeight: '700',
    color: theme.colors.text,
  },
  subtitle: {
    marginTop: theme.spacing.xs,
    fontSize: theme.fontSize.sm,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.md,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  toolName: {
    flex: 1,
    fontSize: theme.fontSize.md,
    fontWeight: '700',
    fontFamily: 'monospace',
    color: theme.colors.purpleDark,
  },
  riskBadge: {
    paddingHorizontal: theme.spacing.sm + 2,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radius.full,
  },
  riskText: {
    fontSize: theme.fontSize.xs,
    fontWeight: '700',
  },
  inputScroll: {
    maxHeight: 200,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceMuted,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  inputContent: {
    padding: theme.spacing.md,
  },
  inputLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: '700',
    color: theme.colors.textMuted,
    marginBottom: theme.spacing.xs,
  },
  inputBody: {
    fontSize: theme.fontSize.xs,
    fontFamily: 'monospace',
    color: theme.colors.text,
    lineHeight: 18,
  },
  actions: {
    marginTop: theme.spacing.lg,
    gap: theme.spacing.sm,
  },
  btn: {
    minHeight: 48,
    borderRadius: theme.radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.md,
  },
  btnDeny: {
    backgroundColor: theme.colors.dangerSoft,
    borderWidth: 1,
    borderColor: theme.colors.danger,
  },
  btnDenyText: {
    color: theme.colors.danger,
    fontWeight: '700',
    fontSize: theme.fontSize.md,
  },
  btnOnce: {
    backgroundColor: theme.colors.primaryDark,
  },
  btnOnceText: {
    color: theme.colors.textInverse,
    fontWeight: '700',
    fontSize: theme.fontSize.md,
  },
  btnSession: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1.5,
    borderColor: theme.colors.primary,
  },
  btnSessionText: {
    color: theme.colors.primaryDark,
    fontWeight: '700',
    fontSize: theme.fontSize.md,
  },
  btnPressed: {
    opacity: 0.75,
  },
});
