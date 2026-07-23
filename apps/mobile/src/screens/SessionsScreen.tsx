import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { SessionSummary } from '@mobile-claude/protocol';
import type { MainStackParamList } from '../navigation';
import { useConnection } from '../state/connection';
import { useSessions } from '../state/sessions';
import { theme } from '../theme';

type Props = NativeStackScreenProps<MainStackParamList, 'Sessions'>;

function formatTime(ts: number): string {
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

function statusLabel(
  status: string,
): { text: string; color: string; bg: string } {
  switch (status) {
    case 'authenticated':
      return {
        text: '已连接',
        color: theme.colors.success,
        bg: theme.colors.successSoft,
      };
    case 'connecting':
    case 'authenticating':
    case 'open':
      return {
        text: '连接中…',
        color: theme.colors.warning,
        bg: theme.colors.warningSoft,
      };
    case 'error':
      return {
        text: '连接错误',
        color: theme.colors.danger,
        bg: theme.colors.dangerSoft,
      };
    default:
      return {
        text: '未连接',
        color: theme.colors.textSecondary,
        bg: theme.colors.surfaceMuted,
      };
  }
}

/**
 * Session list from session.list; FAB creates; tap opens Chat; long-press deletes.
 */
export function SessionsScreen({ navigation }: Props) {
  const { status, error: connError, reconnect, connectionInfo } = useConnection();
  const { sessions, loading, error, refresh, createSession, deleteSession } =
    useSessions();
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      if (status !== 'authenticated') {
        await reconnect();
      }
      await refresh();
    } catch {
      // errors surfaced via context
    } finally {
      setRefreshing(false);
    }
  }, [refresh, reconnect, status]);

  const onCreate = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      if (status !== 'authenticated') {
        await reconnect();
      }
      const created = await createSession();
      if (created) {
        navigation.navigate('Chat', { sessionId: created.id });
      }
    } catch (err) {
      Alert.alert(
        '创建失败',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setCreating(false);
    }
  }, [creating, createSession, navigation, reconnect, status]);

  const confirmDelete = useCallback(
    (item: SessionSummary) => {
      Alert.alert('删除会话', `确定删除「${item.title || '未命名会话'}」？`, [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            void deleteSession(item.id).catch((err: unknown) => {
              Alert.alert(
                '删除失败',
                err instanceof Error ? err.message : String(err),
              );
            });
          },
        },
      ]);
    },
    [deleteSession],
  );

  const badge = statusLabel(status);
  const displayError = error ?? connError;

  const renderItem = useCallback(
    ({ item }: { item: SessionSummary }) => (
      <Pressable
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        onPress={() => navigation.navigate('Chat', { sessionId: item.id })}
        onLongPress={() => confirmDelete(item)}
      >
        <View style={styles.rowBody}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {item.title || '未命名会话'}
          </Text>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {item.model ? `${item.model} · ` : ''}
            {formatTime(item.updatedAt)}
          </Text>
        </View>
        <Text style={styles.chevron}>›</Text>
      </Pressable>
    ),
    [confirmDelete, navigation],
  );

  return (
    <View style={styles.root}>
      <View style={styles.headerCard}>
        <View style={styles.headerTop}>
          <Text style={styles.headerTitle}>会话</Text>
          <View style={[styles.badge, { backgroundColor: badge.bg }]}>
            <Text style={[styles.badgeText, { color: badge.color }]}>
              {badge.text}
            </Text>
          </View>
        </View>
        {connectionInfo ? (
          <Text style={styles.headerSub} numberOfLines={1}>
            {connectionInfo.host}:{connectionInfo.port}
          </Text>
        ) : null}
        {displayError ? (
          <Text style={styles.errorLine} numberOfLines={2}>
            {displayError}
          </Text>
        ) : null}
        <View style={styles.headerActions}>
          <Pressable
            onPress={() => navigation.navigate('Files')}
            style={styles.linkBtn}
          >
            <Text style={styles.linkBtnText}>文件</Text>
          </Pressable>
          <Pressable
            onPress={() => navigation.navigate('Settings')}
            style={styles.linkBtn}
          >
            <Text style={styles.linkBtnText}>设置</Text>
          </Pressable>
        </View>
      </View>

      {loading && sessions.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={styles.hint}>加载会话列表…</Text>
        </View>
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={
            sessions.length === 0 ? styles.emptyList : styles.list
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                void onRefresh();
              }}
              tintColor={theme.colors.primary}
            />
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyTitle}>还没有会话</Text>
              <Text style={styles.hint}>点右下角 + 新建，或下拉刷新</Text>
            </View>
          }
        />
      )}

      <Pressable
        style={({ pressed }) => [
          styles.fab,
          pressed && styles.fabPressed,
          creating && styles.fabDisabled,
        ]}
        onPress={() => {
          void onCreate();
        }}
        disabled={creating}
        accessibilityLabel="新建会话"
      >
        {creating ? (
          <ActivityIndicator color={theme.colors.textInverse} />
        ) : (
          <Text style={styles.fabText}>+</Text>
        )}
      </Pressable>
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
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: theme.spacing.xs,
  },
  headerTitle: {
    fontSize: theme.fontSize.xl,
    fontWeight: '700',
    color: theme.colors.text,
  },
  badge: {
    paddingHorizontal: theme.spacing.sm + 2,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radius.full,
  },
  badgeText: {
    fontSize: theme.fontSize.xs,
    fontWeight: '700',
  },
  headerSub: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.xs,
  },
  errorLine: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.danger,
    marginBottom: theme.spacing.xs,
  },
  headerActions: {
    flexDirection: 'row',
    gap: theme.spacing.md,
    marginTop: theme.spacing.sm,
  },
  linkBtn: {
    paddingVertical: theme.spacing.xs,
  },
  linkBtnText: {
    color: theme.colors.primaryDark,
    fontWeight: '600',
    fontSize: theme.fontSize.sm,
  },
  list: {
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: 96,
  },
  emptyList: {
    flexGrow: 1,
    paddingBottom: 96,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    marginBottom: theme.spacing.sm,
  },
  rowPressed: {
    opacity: 0.85,
    backgroundColor: theme.colors.surfaceMuted,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
  },
  rowTitle: {
    fontSize: theme.fontSize.md,
    fontWeight: '600',
    color: theme.colors.text,
    marginBottom: 2,
  },
  rowMeta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.textSecondary,
  },
  chevron: {
    fontSize: 22,
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
  fab: {
    position: 'absolute',
    right: theme.spacing.lg,
    bottom: theme.spacing.lg,
    width: 56,
    height: 56,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.primaryDark,
    alignItems: 'center',
    justifyContent: 'center',
    ...theme.shadow.soft,
  },
  fabPressed: {
    opacity: 0.9,
  },
  fabDisabled: {
    opacity: 0.75,
  },
  fabText: {
    color: theme.colors.textInverse,
    fontSize: 32,
    fontWeight: '400',
    marginTop: -2,
  },
});
