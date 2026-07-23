import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../navigation';
import { useConnection } from '../state/connection';
import { theme } from '../theme';

type Props = NativeStackScreenProps<MainStackParamList, 'Settings'>;

type ConfigPayload = {
  model?: string;
  autoAllowReadTools?: boolean;
  workspaceRoot?: string;
  host?: string;
  port?: number;
  serverVersion?: string;
  hasApiKey?: boolean;
};

function statusLabel(status: string): {
  text: string;
  color: string;
  bg: string;
} {
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
 * Settings: connection info, workspace, auto-allow reads, disconnect.
 */
export function SettingsScreen({ navigation }: Props) {
  const {
    client,
    status,
    connectionInfo,
    auth,
    error: connError,
    reconnect,
    disconnectAndForget,
  } = useConnection();

  const [config, setConfig] = useState<ConfigPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const loadConfig = useCallback(async () => {
    if (!client) {
      setLoading(false);
      setConfig(null);
      return;
    }
    setLoading(true);
    setLocalError(null);
    try {
      if (status !== 'authenticated') {
        await reconnect();
      }
      const env = await client.request(
        'config.get',
        {},
        ['config'],
        { timeoutMs: 15_000 },
      );
      setConfig((env.payload ?? {}) as ConfigPayload);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client, reconnect, status]);

  useFocusEffect(
    useCallback(() => {
      void loadConfig();
    }, [loadConfig]),
  );

  const onToggleAutoAllow = useCallback(
    async (value: boolean) => {
      if (!client || toggling) return;
      setToggling(true);
      setLocalError(null);
      const prev = config?.autoAllowReadTools;
      // Optimistic
      setConfig((c) => (c ? { ...c, autoAllowReadTools: value } : c));
      try {
        if (status !== 'authenticated') {
          await reconnect();
        }
        const env = await client.request(
          'config.set',
          { autoAllowReadTools: value },
          ['config'],
          { timeoutMs: 15_000 },
        );
        setConfig((env.payload ?? {}) as ConfigPayload);
      } catch (err) {
        setConfig((c) =>
          c && prev !== undefined ? { ...c, autoAllowReadTools: prev } : c,
        );
        setLocalError(err instanceof Error ? err.message : String(err));
      } finally {
        setToggling(false);
      }
    },
    [client, config?.autoAllowReadTools, reconnect, status, toggling],
  );

  const onDisconnect = useCallback(() => {
    Alert.alert(
      '断开并清除配对',
      '将清除本机保存的设备令牌，需要重新配对才能连接。确定继续？',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '断开',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              if (disconnecting) return;
              setDisconnecting(true);
              try {
                await disconnectAndForget();
                const root = navigation.getParent();
                if (root) {
                  root.reset({
                    index: 0,
                    routes: [{ name: 'Pair' }],
                  });
                }
              } catch (err) {
                setLocalError(
                  err instanceof Error ? err.message : String(err),
                );
                setDisconnecting(false);
              }
            })();
          },
        },
      ],
    );
  }, [disconnectAndForget, disconnecting, navigation]);

  const badge = statusLabel(status);
  const workspace =
    config?.workspaceRoot ?? auth?.workspaceRoot ?? '—';
  const model = config?.model ?? '—';
  const autoAllow = config?.autoAllowReadTools ?? true;
  const hostPort = connectionInfo
    ? `${connectionInfo.host}:${connectionInfo.port}`
    : config?.host && config?.port
      ? `${config.host}:${config.port}`
      : '—';
  const serverVersion =
    config?.serverVersion ?? auth?.serverVersion ?? '—';
  const displayError = localError ?? connError;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>连接</Text>
          <View style={[styles.badge, { backgroundColor: badge.bg }]}>
            <Text style={[styles.badgeText, { color: badge.color }]}>
              {badge.text}
            </Text>
          </View>
        </View>
        <Row label="地址" value={hostPort} />
        <Row label="设备 ID" value={auth?.deviceId ?? '—'} mono />
        <Row label="服务版本" value={serverVersion} />
        <Row
          label="API Key"
          value={
            config?.hasApiKey === true
              ? '宿主已配置'
              : config?.hasApiKey === false
                ? '未配置'
                : '—'
          }
        />
        {status !== 'authenticated' ? (
          <Pressable
            style={({ pressed }) => [
              styles.secondaryBtn,
              pressed && styles.btnPressed,
            ]}
            onPress={() => {
              void reconnect().catch((err: unknown) => {
                setLocalError(
                  err instanceof Error ? err.message : String(err),
                );
              });
            }}
          >
            <Text style={styles.secondaryBtnText}>重新连接</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>工作区</Text>
        {loading && !config ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={theme.colors.primary} />
            <Text style={styles.loadingText}>加载配置…</Text>
          </View>
        ) : (
          <>
            <Row label="路径" value={workspace} mono />
            <Row label="默认模型" value={model} mono />
          </>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>权限</Text>
        <View style={styles.switchRow}>
          <View style={styles.switchLabels}>
            <Text style={styles.switchTitle}>自动允许读工具</Text>
            <Text style={styles.switchHint}>
              开启后 Read / Glob / Grep 无需每次确认；写操作与 Bash 仍会弹窗
            </Text>
          </View>
          <Switch
            value={autoAllow}
            onValueChange={(v) => {
              void onToggleAutoAllow(v);
            }}
            disabled={!client || toggling || loading}
            trackColor={{
              false: theme.colors.border,
              true: theme.colors.primaryLight,
            }}
            thumbColor={
              autoAllow ? theme.colors.primaryDark : theme.colors.surface
            }
          />
        </View>
      </View>

      {displayError ? (
        <Pressable
          style={styles.errorBanner}
          onPress={() => {
            setLocalError(null);
            void loadConfig();
          }}
        >
          <Text style={styles.errorText} numberOfLines={4}>
            {displayError}（点按重试）
          </Text>
        </Pressable>
      ) : null}

      <Pressable
        style={({ pressed }) => [
          styles.dangerBtn,
          pressed && styles.btnPressed,
          disconnecting && styles.btnDisabled,
        ]}
        onPress={onDisconnect}
        disabled={disconnecting}
        accessibilityLabel="断开连接并清除配对"
      >
        {disconnecting ? (
          <ActivityIndicator color={theme.colors.danger} />
        ) : (
          <Text style={styles.dangerBtnText}>断开连接并清除配对</Text>
        )}
      </Pressable>

      <Text style={styles.footerNote}>
        API Key 仅能在宿主环境配置，应用不会通过网络接收密钥。
      </Text>
    </ScrollView>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text
        style={[styles.rowValue, mono && styles.mono]}
        selectable
        numberOfLines={3}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    padding: theme.spacing.lg,
    paddingBottom: theme.spacing.xxl,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.md,
    ...theme.shadow.soft,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: theme.spacing.sm,
  },
  cardTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: theme.spacing.sm,
  },
  badge: {
    paddingHorizontal: theme.spacing.sm + 2,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radius.full,
    marginBottom: theme.spacing.sm,
  },
  badgeText: {
    fontSize: theme.fontSize.xs,
    fontWeight: '700',
  },
  row: {
    marginBottom: theme.spacing.sm,
  },
  rowLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.textSecondary,
    marginBottom: 2,
    fontWeight: '600',
  },
  rowValue: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.text,
  },
  mono: {
    fontFamily: 'monospace',
    fontSize: theme.fontSize.xs,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  loadingText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.textSecondary,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
  },
  switchLabels: {
    flex: 1,
    minWidth: 0,
  },
  switchTitle: {
    fontSize: theme.fontSize.md,
    fontWeight: '600',
    color: theme.colors.text,
    marginBottom: 4,
  },
  switchHint: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.textSecondary,
    lineHeight: 18,
  },
  secondaryBtn: {
    marginTop: theme.spacing.sm,
    alignSelf: 'flex-start',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.full,
    backgroundColor: '#EEF2FF',
  },
  secondaryBtnText: {
    color: theme.colors.primaryDark,
    fontWeight: '700',
    fontSize: theme.fontSize.sm,
  },
  errorBanner: {
    padding: theme.spacing.md,
    backgroundColor: theme.colors.dangerSoft,
    borderRadius: theme.radius.md,
    marginBottom: theme.spacing.md,
  },
  errorText: {
    color: theme.colors.danger,
    fontSize: theme.fontSize.xs,
  },
  dangerBtn: {
    borderWidth: 1,
    borderColor: theme.colors.danger,
    backgroundColor: theme.colors.dangerSoft,
    borderRadius: theme.radius.lg,
    paddingVertical: theme.spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  dangerBtnText: {
    color: theme.colors.danger,
    fontWeight: '700',
    fontSize: theme.fontSize.md,
  },
  btnPressed: {
    opacity: 0.88,
  },
  btnDisabled: {
    opacity: 0.65,
  },
  footerNote: {
    marginTop: theme.spacing.md,
    fontSize: theme.fontSize.xs,
    color: theme.colors.textMuted,
    textAlign: 'center',
    lineHeight: 18,
  },
});
