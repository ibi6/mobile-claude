import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { theme } from '../theme';

export type DiffViewerProps = {
  visible: boolean;
  path: string;
  unifiedDiff: string;
  onClose: () => void;
};

type DiffLine = {
  key: string;
  text: string;
  kind: 'add' | 'del' | 'hunk' | 'meta' | 'ctx';
};

function classifyLine(line: string): DiffLine['kind'] {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) {
    return 'meta';
  }
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

function parseDiff(unifiedDiff: string): DiffLine[] {
  if (!unifiedDiff) {
    return [{ key: '0', text: '（无 diff）', kind: 'ctx' }];
  }
  const lines = unifiedDiff.replace(/\r\n/g, '\n').split('\n');
  // Drop trailing empty line from split
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.map((text, i) => ({
    key: String(i),
    text: text.length === 0 ? ' ' : text,
    kind: classifyLine(text),
  }));
}

/**
 * Full-screen-ish modal showing a unified diff in monospace.
 */
export function DiffViewer({
  visible,
  path,
  unifiedDiff,
  onClose,
}: DiffViewerProps) {
  const lines = parseDiff(unifiedDiff);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.title}>文件变更</Text>
              <Text style={styles.path} numberOfLines={2} selectable>
                {path || '（未知路径）'}
              </Text>
            </View>
            <Pressable
              onPress={onClose}
              style={({ pressed }) => [
                styles.closeBtn,
                pressed && styles.closeBtnPressed,
              ]}
              accessibilityLabel="关闭"
            >
              <Text style={styles.closeBtnText}>关闭</Text>
            </Pressable>
          </View>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            horizontal={false}
          >
            <ScrollView horizontal nestedScrollEnabled>
              <View>
                {lines.map((line) => (
                  <Text
                    key={line.key}
                    style={[
                      styles.line,
                      line.kind === 'add' && styles.lineAdd,
                      line.kind === 'del' && styles.lineDel,
                      line.kind === 'hunk' && styles.lineHunk,
                      line.kind === 'meta' && styles.lineMeta,
                    ]}
                    selectable
                  >
                    {line.text}
                  </Text>
                ))}
              </View>
            </ScrollView>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: theme.colors.overlay,
    justifyContent: 'center',
    padding: theme.spacing.md,
  },
  card: {
    flex: 1,
    maxHeight: '88%',
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    overflow: 'hidden',
    ...theme.shadow.soft,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceMuted,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: theme.fontSize.md,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: 2,
  },
  path: {
    fontSize: theme.fontSize.xs,
    fontFamily: 'monospace',
    color: theme.colors.purpleDark,
  },
  closeBtn: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.primaryDark,
  },
  closeBtnPressed: {
    opacity: 0.85,
  },
  closeBtnText: {
    color: theme.colors.textInverse,
    fontWeight: '700',
    fontSize: theme.fontSize.sm,
  },
  scroll: {
    flex: 1,
    backgroundColor: '#0F172A',
  },
  scrollContent: {
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.sm,
  },
  line: {
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 18,
    color: '#E2E8F0',
  },
  lineAdd: {
    color: '#86EFAC',
    backgroundColor: 'rgba(34, 197, 94, 0.12)',
  },
  lineDel: {
    color: '#FCA5A5',
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
  },
  lineHunk: {
    color: '#A5B4FC',
  },
  lineMeta: {
    color: '#94A3B8',
  },
});
