import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../navigation';
import { useConnection } from '../state/connection';
import { theme } from '../theme';

type Props = NativeStackScreenProps<MainStackParamList, 'Files'>;

type FsEntry = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
};

type FsListResult = {
  path: string;
  entries: FsEntry[];
};

type FsReadResult = {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
};

type PreviewState = {
  path: string;
  loading: boolean;
  content: string | null;
  binary: boolean;
  truncated: boolean;
  size: number | null;
  error: string | null;
};

const MAX_PREVIEW_BYTES = 256_000;

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Heuristic: null bytes / many control or replacement chars → binary. */
function looksBinary(content: string): boolean {
  if (content.includes('\0')) return true;
  const sample = content.slice(0, 8192);
  if (sample.length === 0) return false;
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0xfffd) {
      bad += 1;
      continue;
    }
    // Control chars except tab / LF / CR
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) {
      bad += 1;
    }
  }
  return bad / sample.length > 0.1;
}

function parentPath(path: string): string {
  if (!path || path === '.' || path === '/') return '';
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return '';
  return normalized.slice(0, idx);
}

function displayDirLabel(path: string): string {
  if (!path || path === '.' || path === '') return '工作区';
  return path.replace(/\\/g, '/');
}

/**
 * Workspace file browser: fs.list tree + fs.read text preview.
 */
export function FilesScreen(_props: Props) {
  const { client, status, reconnect, auth } = useConnection();

  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;

  const listDir = useCallback(
    async (path: string, opts?: { soft?: boolean }) => {
      if (!client) {
        setError('未连接 Agent');
        setLoading(false);
        return;
      }
      if (!opts?.soft) {
        setLoading(true);
      }
      setError(null);
      try {
        if (status !== 'authenticated') {
          await reconnect();
        }
        const listPath = path === '' ? '.' : path;
        const env = await client.request(
          'fs.list',
          { path: listPath },
          ['fs.list_result'],
          { timeoutMs: 20_000 },
        );
        const result = env.payload as FsListResult;
        setCurrentPath(result.path ?? (path === '.' ? '' : path));
        setEntries(Array.isArray(result.entries) ? result.entries : []);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [client, reconnect, status],
  );

  // Refresh current directory on each focus (keep path via ref)
  useFocusEffect(
    useCallback(() => {
      void listDir(currentPathRef.current || '.');
    }, [listDir]),
  );

  const openEntry = useCallback(
    async (entry: FsEntry) => {
      if (entry.type === 'directory') {
        void listDir(entry.path);
        return;
      }

      setPreview({
        path: entry.path,
        loading: true,
        content: null,
        binary: false,
        truncated: false,
        size: entry.size ?? null,
        error: null,
      });

      if (!client) {
        setPreview({
          path: entry.path,
          loading: false,
          content: null,
          binary: false,
          truncated: false,
          size: entry.size ?? null,
          error: '未连接 Agent',
        });
        return;
      }

      try {
        if (status !== 'authenticated') {
          await reconnect();
        }
        const env = await client.request(
          'fs.read',
          { path: entry.path, maxBytes: MAX_PREVIEW_BYTES },
          ['fs.read_result'],
          { timeoutMs: 20_000 },
        );
        const result = env.payload as FsReadResult;
        const content = typeof result.content === 'string' ? result.content : '';
        const binary = looksBinary(content);
        setPreview({
          path: result.path || entry.path,
          loading: false,
          content: binary ? null : content,
          binary,
          truncated: Boolean(result.truncated),
          size: typeof result.size === 'number' ? result.size : entry.size ?? null,
          error: null,
        });
      } catch (err) {
        setPreview({
          path: entry.path,
          loading: false,
          content: null,
          binary: false,
          truncated: false,
          size: entry.size ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [client, listDir, reconnect, status],
  );

  const goUp = useCallback(() => {
    if (!currentPath) return;
    const parent = parentPath(currentPath);
    void listDir(parent === '' ? '.' : parent);
  }, [currentPath, listDir]);

  const renderItem = useCallback(
    ({ item }: { item: FsEntry }) => {
      const isDir = item.type === 'directory';
      return (
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => {
            void openEntry(item);
          }}
          accessibilityLabel={isDir ? `打开目录 ${item.name}` : `预览文件 ${item.name}`}
        >
          <View style={[styles.iconBadge, isDir ? styles.iconDir : styles.iconFile]}>
            <Text style={styles.iconText}>{isDir ? '📁' : '📄'}</Text>
          </View>
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={styles.rowMeta} numberOfLines={1}>
              {isDir ? '目录' : formatSize(item.size) || '文件'}
            </Text>
          </View>
          <Text style={styles.chevron}>{isDir ? '›' : '◎'}</Text>
        </Pressable>
      );
    },
    [openEntry],
  );

  const workspaceHint = auth?.workspaceRoot
    ? auth.workspaceRoot
    : '（连接后显示工作区路径）';

  return (
    <View style={styles.root}>
      <View style={styles.headerCard}>
        <Text style={styles.headerTitle}>文件</Text>
        <Text style={styles.headerSub} numberOfLines={2}>
          {workspaceHint}
        </Text>
        <View style={styles.breadcrumb}>
          {currentPath ? (
            <Pressable onPress={goUp} style={styles.upBtn} accessibilityLabel="返回上级">
              <Text style={styles.upBtnText}>‹ 上级</Text>
            </Pressable>
          ) : null}
          <Text style={styles.pathText} numberOfLines={2}>
            {displayDirLabel(currentPath)}
          </Text>
        </View>
        {error ? (
          <Pressable
            onPress={() => {
              void listDir(currentPath || '.');
            }}
          >
            <Text style={styles.errorLine} numberOfLines={3}>
              {error}（点按重试）
            </Text>
          </Pressable>
        ) : null}
      </View>

      {loading && entries.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={styles.hint}>加载目录…</Text>
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => `${item.type}:${item.path}`}
          renderItem={renderItem}
          contentContainerStyle={
            entries.length === 0 ? styles.emptyList : styles.list
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                void listDir(currentPath || '.', { soft: true });
              }}
              tintColor={theme.colors.primary}
            />
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyTitle}>空目录</Text>
              <Text style={styles.hint}>此路径下没有可显示的文件</Text>
            </View>
          }
        />
      )}

      <Modal
        visible={preview !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setPreview(null)}
      >
        <View style={styles.modalRoot}>
          <View style={styles.modalHeader}>
            <View style={styles.modalHeaderText}>
              <Text style={styles.modalTitle} numberOfLines={2}>
                {preview?.path ?? '预览'}
              </Text>
              {preview?.size != null ? (
                <Text style={styles.modalMeta}>
                  {formatSize(preview.size)}
                  {preview.truncated ? ' · 已截断' : ''}
                </Text>
              ) : null}
            </View>
            <Pressable
              style={styles.closeBtn}
              onPress={() => setPreview(null)}
              accessibilityLabel="关闭预览"
            >
              <Text style={styles.closeBtnText}>关闭</Text>
            </Pressable>
          </View>

          {preview?.loading ? (
            <View style={styles.center}>
              <ActivityIndicator size="large" color={theme.colors.primary} />
              <Text style={styles.hint}>读取文件…</Text>
            </View>
          ) : preview?.error ? (
            <View style={styles.center}>
              <Text style={styles.emptyTitle}>读取失败</Text>
              <Text style={styles.hint}>{preview.error}</Text>
            </View>
          ) : preview?.binary ? (
            <View style={styles.center}>
              <Text style={styles.emptyTitle}>二进制文件</Text>
              <Text style={styles.hint}>仅支持文本预览，无法显示此文件内容</Text>
            </View>
          ) : (
            <ScrollView
              style={styles.previewScroll}
              contentContainerStyle={styles.previewContent}
            >
              <Text style={styles.previewText} selectable>
                {preview?.content ?? ''}
              </Text>
              {preview?.truncated ? (
                <Text style={styles.truncatedNote}>
                  …内容已截断（最多 {formatSize(MAX_PREVIEW_BYTES)}）
                </Text>
              ) : null}
            </ScrollView>
          )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  headerCard: {
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...theme.shadow.soft,
  },
  headerTitle: {
    fontSize: theme.fontSize.xl,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: theme.spacing.xs,
  },
  headerSub: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.sm,
  },
  breadcrumb: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  upBtn: {
    paddingVertical: theme.spacing.xs,
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radius.full,
    backgroundColor: '#EEF2FF',
  },
  upBtnText: {
    color: theme.colors.primaryDark,
    fontWeight: '700',
    fontSize: theme.fontSize.sm,
  },
  pathText: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: '600',
    color: theme.colors.text,
  },
  errorLine: {
    marginTop: theme.spacing.sm,
    fontSize: theme.fontSize.xs,
    color: theme.colors.danger,
  },
  list: {
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.xl,
  },
  emptyList: {
    flexGrow: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm + 2,
    marginBottom: theme.spacing.sm,
  },
  rowPressed: {
    opacity: 0.85,
    backgroundColor: theme.colors.surfaceMuted,
  },
  iconBadge: {
    width: 36,
    height: 36,
    borderRadius: theme.radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: theme.spacing.sm,
  },
  iconDir: {
    backgroundColor: '#EEF2FF',
  },
  iconFile: {
    backgroundColor: theme.colors.surfaceMuted,
  },
  iconText: {
    fontSize: 16,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
  },
  rowTitle: {
    fontSize: theme.fontSize.md,
    fontWeight: '600',
    color: theme.colors.text,
  },
  rowMeta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.textSecondary,
    marginTop: 2,
  },
  chevron: {
    fontSize: 18,
    color: theme.colors.textMuted,
    marginLeft: theme.spacing.sm,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.lg,
  },
  emptyTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: '600',
    color: theme.colors.text,
    marginBottom: theme.spacing.sm,
  },
  hint: {
    marginTop: theme.spacing.sm,
    fontSize: theme.fontSize.sm,
    color: theme.colors.textSecondary,
    textAlign: 'center',
  },
  modalRoot: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.lg,
    paddingBottom: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    gap: theme.spacing.sm,
  },
  modalHeaderText: {
    flex: 1,
    minWidth: 0,
  },
  modalTitle: {
    fontSize: theme.fontSize.md,
    fontWeight: '700',
    color: theme.colors.text,
  },
  modalMeta: {
    marginTop: 4,
    fontSize: theme.fontSize.xs,
    color: theme.colors.textSecondary,
  },
  closeBtn: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceMuted,
  },
  closeBtnText: {
    color: theme.colors.primaryDark,
    fontWeight: '700',
    fontSize: theme.fontSize.sm,
  },
  previewScroll: {
    flex: 1,
  },
  previewContent: {
    padding: theme.spacing.lg,
  },
  previewText: {
    fontFamily: 'monospace',
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.text,
  },
  truncatedNote: {
    marginTop: theme.spacing.md,
    fontSize: theme.fontSize.xs,
    color: theme.colors.warning,
  },
});
