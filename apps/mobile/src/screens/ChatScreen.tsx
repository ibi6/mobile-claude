import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type {
  ChatMessage,
  DiffAvailablePayload,
  Envelope,
  ErrorPayload,
  MessageCompletedPayload,
  MessageDeltaPayload,
  PermissionDecision,
  PermissionRequestPayload,
  SessionPhase,
  SessionSnapshotPayload,
  StatusPayload,
  ToolCompletedPayload,
  ToolProgressPayload,
  ToolStartedPayload,
} from '@mobile-claude/protocol';
import { DiffViewer } from '../components/DiffViewer';
import { MessageBubble } from '../components/MessageBubble';
import { PermissionSheet } from '../components/PermissionSheet';
import { ToolCard } from '../components/ToolCard';
import type { MainStackParamList } from '../navigation';
import { useConnection } from '../state/connection';
import { theme } from '../theme';

type Props = NativeStackScreenProps<MainStackParamList, 'Chat'>;

type MessageItem = {
  kind: 'message';
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  streaming?: boolean;
};

type ToolItem = {
  kind: 'tool';
  id: string;
  toolRunId: string;
  name: string;
  inputSummary: string;
  status: string;
  outputSummary?: string;
};

type TimelineItem = MessageItem | ToolItem;

type DiffEntry = {
  toolRunId: string;
  path: string;
  unifiedDiff: string;
};

function newLocalId(prefix: string): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') {
    return `${prefix}-${c.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || typeof content !== 'object' || Array.isArray(content)) {
    return '';
  }
  const c = content as Record<string, unknown>;
  if (typeof c.text === 'string') return c.text;
  return '';
}

function mapRole(role: ChatMessage['role']): MessageItem['role'] | null {
  if (role === 'user' || role === 'assistant' || role === 'system') return role;
  // tool rows are not rendered as bubbles (tool cards come from live events)
  return null;
}

function messagesToTimeline(messages: ChatMessage[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const m of messages) {
    const role = mapRole(m.role);
    if (!role) continue;
    items.push({
      kind: 'message',
      id: m.id,
      role,
      text: extractMessageText(m.content),
    });
  }
  return items;
}

function phaseLabel(phase: SessionPhase | null, busy: boolean): {
  text: string;
  color: string;
  bg: string;
} {
  if (!busy && (!phase || phase === 'idle')) {
    return {
      text: '空闲',
      color: theme.colors.success,
      bg: theme.colors.successSoft,
    };
  }
  switch (phase) {
    case 'thinking':
      return {
        text: '思考中',
        color: theme.colors.primaryDark,
        bg: '#EEF2FF',
      };
    case 'tool':
      return {
        text: '工具中',
        color: theme.colors.purpleDark,
        bg: '#F5F3FF',
      };
    case 'awaiting_permission':
      return {
        text: '等待授权',
        color: theme.colors.warning,
        bg: theme.colors.warningSoft,
      };
    default:
      return {
        text: busy ? '忙碌' : '空闲',
        color: busy ? theme.colors.warning : theme.colors.success,
        bg: busy ? theme.colors.warningSoft : theme.colors.successSoft,
      };
  }
}

function sameSession(env: Envelope, sessionId: string): boolean {
  // Prefer envelope sessionId; fall back to payload.sessionId when present
  if (env.sessionId && env.sessionId === sessionId) return true;
  if (env.sessionId && env.sessionId !== sessionId) return false;
  const p = env.payload as { sessionId?: unknown } | null;
  if (p && typeof p === 'object' && typeof p.sessionId === 'string') {
    return p.sessionId === sessionId;
  }
  // Events without sessionId are ignored for safety
  return false;
}

/** Match `/model` / `/clear` at start (space or end after command). */
const SLASH_CMD_RE = /^\/(model|clear)(\s|$)/;

function parseSlashCommand(
  text: string,
): { command: 'model' | 'clear'; args?: string } | null {
  const m = text.match(SLASH_CMD_RE);
  if (!m) return null;
  const command = m[1] as 'model' | 'clear';
  const rest = text.slice(m[0].length).trim();
  return { command, args: rest.length > 0 ? rest : undefined };
}

/**
 * Chat: open snapshot on focus, stream deltas, tool cards, abort.
 */
export function ChatScreen({ navigation, route }: Props) {
  const sessionId = route.params?.sessionId;
  const { client, status: connStatus, reconnect } = useConnection();

  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [title, setTitle] = useState('对话');
  const [phase, setPhase] = useState<SessionPhase | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [pendingPermission, setPendingPermission] =
    useState<PermissionRequestPayload | null>(null);
  const [permissionResponding, setPermissionResponding] = useState(false);
  /** toolRunId → diff payload for ToolCard chip */
  const [diffsByTool, setDiffsByTool] = useState<Record<string, DiffEntry>>({});
  const [activeDiff, setActiveDiff] = useState<DiffEntry | null>(null);

  const listRef = useRef<FlatList<TimelineItem>>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // Reset per-session UI when navigating to another chat
  useEffect(() => {
    setDiffsByTool({});
    setActiveDiff(null);
    setPendingPermission(null);
    setPermissionResponding(false);
  }, [sessionId]);

  const applyStatus = useCallback((s: StatusPayload) => {
    setPhase(s.phase);
    setModel(s.model);
    setBusy(s.busy);
  }, []);

  const applySnapshot = useCallback(
    (snap: SessionSnapshotPayload) => {
      setTitle(snap.title || '对话');
      setTimeline(messagesToTimeline(snap.messages ?? []));
      if (snap.status) {
        applyStatus(snap.status);
      }
      // Resume pending permission after reconnect / session.open
      if (snap.pendingPermission) {
        setPendingPermission(snap.pendingPermission);
        setPermissionResponding(false);
      } else {
        setPendingPermission(null);
        setPermissionResponding(false);
      }
      setError(null);
    },
    [applyStatus],
  );

  const openSession = useCallback(async () => {
    if (!client || !sessionId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (connStatus !== 'authenticated') {
        await reconnect();
      }
      const env = await client.request(
        'session.open',
        { sessionId },
        ['session.snapshot'],
        { sessionId, timeoutMs: 20_000 },
      );
      if (sessionIdRef.current !== sessionId) return;
      applySnapshot(env.payload as SessionSnapshotPayload);
    } catch (err) {
      if (sessionIdRef.current !== sessionId) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (sessionIdRef.current === sessionId) {
        setLoading(false);
      }
    }
  }, [applySnapshot, client, connStatus, reconnect, sessionId]);

  // Subscribe while focused; re-open snapshot on each focus
  useFocusEffect(
    useCallback(() => {
      if (!client || !sessionId) {
        setLoading(false);
        return undefined;
      }

      const unsubs: Array<() => void> = [];

      unsubs.push(
        client.on('session.snapshot', (env) => {
          if (!sameSession(env, sessionId)) return;
          applySnapshot(env.payload as SessionSnapshotPayload);
          setLoading(false);
        }),
      );

      unsubs.push(
        client.on('message.delta', (env) => {
          if (!sameSession(env, sessionId)) return;
          const p = env.payload as MessageDeltaPayload;
          if (!p?.messageId || typeof p.text !== 'string') return;
          setTimeline((prev) => {
            const idx = prev.findIndex(
              (it) => it.kind === 'message' && it.id === p.messageId,
            );
            if (idx >= 0) {
              const cur = prev[idx] as MessageItem;
              const next = [...prev];
              next[idx] = {
                ...cur,
                text: cur.text + p.text,
                streaming: true,
              };
              return next;
            }
            return [
              ...prev,
              {
                kind: 'message',
                id: p.messageId,
                role: 'assistant',
                text: p.text,
                streaming: true,
              },
            ];
          });
        }),
      );

      unsubs.push(
        client.on('message.completed', (env) => {
          if (!sameSession(env, sessionId)) return;
          const p = env.payload as MessageCompletedPayload;
          if (!p?.messageId) return;
          setTimeline((prev) =>
            prev.map((it) =>
              it.kind === 'message' && it.id === p.messageId
                ? { ...it, streaming: false }
                : it,
            ),
          );
        }),
      );

      unsubs.push(
        client.on('tool.started', (env) => {
          if (!sameSession(env, sessionId)) return;
          const p = env.payload as ToolStartedPayload;
          if (!p?.toolRunId) return;
          setTimeline((prev) => {
            const exists = prev.some(
              (it) => it.kind === 'tool' && it.toolRunId === p.toolRunId,
            );
            if (exists) {
              return prev.map((it) =>
                it.kind === 'tool' && it.toolRunId === p.toolRunId
                  ? {
                      ...it,
                      name: p.name,
                      inputSummary: p.inputSummary ?? '',
                      status: 'running',
                    }
                  : it,
              );
            }
            return [
              ...prev,
              {
                kind: 'tool',
                id: `tool-${p.toolRunId}`,
                toolRunId: p.toolRunId,
                name: p.name,
                inputSummary: p.inputSummary ?? '',
                status: 'running',
              },
            ];
          });
        }),
      );

      unsubs.push(
        client.on('tool.progress', (env) => {
          if (!sameSession(env, sessionId)) return;
          const p = env.payload as ToolProgressPayload;
          if (!p?.toolRunId || !p.text) return;
          setTimeline((prev) =>
            prev.map((it) =>
              it.kind === 'tool' && it.toolRunId === p.toolRunId
                ? {
                    ...it,
                    outputSummary: (it.outputSummary ?? '') + p.text,
                  }
                : it,
            ),
          );
        }),
      );

      unsubs.push(
        client.on('tool.completed', (env) => {
          if (!sameSession(env, sessionId)) return;
          const p = env.payload as ToolCompletedPayload;
          if (!p?.toolRunId) return;
          setTimeline((prev) => {
            const exists = prev.some(
              (it) => it.kind === 'tool' && it.toolRunId === p.toolRunId,
            );
            if (!exists) {
              return [
                ...prev,
                {
                  kind: 'tool',
                  id: `tool-${p.toolRunId}`,
                  toolRunId: p.toolRunId,
                  name: 'tool',
                  inputSummary: '',
                  status: p.status,
                  outputSummary: p.outputSummary,
                },
              ];
            }
            return prev.map((it) =>
              it.kind === 'tool' && it.toolRunId === p.toolRunId
                ? {
                    ...it,
                    status: p.status,
                    outputSummary: p.outputSummary ?? it.outputSummary,
                  }
                : it,
            );
          });
        }),
      );

      unsubs.push(
        client.on('status', (env) => {
          if (!sameSession(env, sessionId)) return;
          applyStatus(env.payload as StatusPayload);
        }),
      );

      unsubs.push(
        client.on('permission.request', (env) => {
          if (!sameSession(env, sessionId)) return;
          const p = env.payload as PermissionRequestPayload;
          if (!p?.requestId) return;
          setPendingPermission(p);
          setPermissionResponding(false);
          setPhase('awaiting_permission');
          setBusy(true);
        }),
      );

      unsubs.push(
        client.on('diff.available', (env) => {
          if (!sameSession(env, sessionId)) return;
          const p = env.payload as DiffAvailablePayload;
          if (!p?.toolRunId || typeof p.unifiedDiff !== 'string') return;
          const entry: DiffEntry = {
            toolRunId: p.toolRunId,
            path: p.path ?? '',
            unifiedDiff: p.unifiedDiff,
          };
          setDiffsByTool((prev) => ({ ...prev, [p.toolRunId]: entry }));
        }),
      );

      unsubs.push(
        client.on('error', (env) => {
          if (env.sessionId && env.sessionId !== sessionId) return;
          const p = env.payload as ErrorPayload;
          if (p?.message) {
            setError(p.message);
          }
          setSending(false);
          setPermissionResponding(false);
          // Pre-turn / rejected send: server never flipped busy — clear optimistic UI
          const code = p?.code;
          if (
            code === 'busy' ||
            code === 'aborted' ||
            code === 'upstream' ||
            code === 'validation' ||
            code === 'not_found' ||
            code === 'unauthorized' ||
            code === 'forbidden'
          ) {
            setBusy(false);
            setPhase('idle');
            // Stale / unknown permission → clear sheet
            if (code === 'not_found') {
              setPendingPermission(null);
            }
          }
        }),
      );

      void openSession();

      return () => {
        for (const u of unsubs) u();
      };
    }, [applySnapshot, applyStatus, client, openSession, sessionId]),
  );

  const phaseBadge = phaseLabel(phase, busy);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: title || '对话',
      headerRight: () => (
        <View style={styles.headerRight}>
          <View style={[styles.chip, { backgroundColor: phaseBadge.bg }]}>
            <Text style={[styles.chipText, { color: phaseBadge.color }]}>
              {phaseBadge.text}
            </Text>
          </View>
        </View>
      ),
    });
  }, [navigation, phaseBadge.bg, phaseBadge.color, phaseBadge.text, title]);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });
  }, []);

  useEffect(() => {
    scrollToEnd();
  }, [timeline, scrollToEnd]);

  const onSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || !client || !sessionId || sending || busy) return;

    setSending(true);
    setError(null);
    setDraft('');

    const slash = parseSlashCommand(text);

    try {
      if (connStatus !== 'authenticated') {
        await reconnect();
      }

      if (slash) {
        // /model and /clear → slash.run (not chat.send)
        const payload: {
          sessionId: string;
          command: 'model' | 'clear';
          args?: string;
        } = {
          sessionId,
          command: slash.command,
        };
        if (slash.args !== undefined) {
          payload.args = slash.args;
        }
        client.send('slash.run', payload, sessionId);

        // Local feedback; /clear will be replaced by empty session.snapshot
        if (slash.command === 'clear') {
          setTimeline([]);
          setDiffsByTool({});
          setActiveDiff(null);
          setPendingPermission(null);
        } else if (slash.command === 'model') {
          const note = slash.args
            ? `已请求切换模型：${slash.args}`
            : '用法：/model <模型名>';
          setTimeline((prev) => [
            ...prev,
            {
              kind: 'message',
              id: newLocalId('local-system'),
              role: 'system',
              text: note,
            },
          ]);
          if (slash.args) {
            setModel(slash.args);
          }
        }
        return;
      }

      const localId = newLocalId('local-user');
      setTimeline((prev) => [
        ...prev,
        { kind: 'message', id: localId, role: 'user', text },
      ]);
      setBusy(true);
      setPhase('thinking');
      client.send('chat.send', { sessionId, text }, sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (!slash) {
        setBusy(false);
        setPhase('idle');
      }
      // Keep optimistic user bubble; mark error visibly
    } finally {
      setSending(false);
    }
  }, [busy, client, connStatus, draft, reconnect, sending, sessionId]);

  const onAbort = useCallback(() => {
    if (!client || !sessionId) return;
    try {
      client.send('chat.abort', { sessionId }, sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, sessionId]);

  const onPermissionRespond = useCallback(
    (decision: PermissionDecision) => {
      if (!client || !sessionId || !pendingPermission || permissionResponding) {
        return;
      }
      setPermissionResponding(true);
      try {
        client.send(
          'permission.respond',
          {
            requestId: pendingPermission.requestId,
            decision,
          },
          sessionId,
        );
        // Clear sheet optimistically; server will continue the loop
        setPendingPermission(null);
        setPermissionResponding(false);
      } catch (err) {
        setPermissionResponding(false);
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [client, pendingPermission, permissionResponding, sessionId],
  );

  const renderItem = useCallback(
    ({ item }: { item: TimelineItem }) => {
      if (item.kind === 'tool') {
        const diff = diffsByTool[item.toolRunId];
        return (
          <ToolCard
            name={item.name}
            inputSummary={item.inputSummary}
            status={item.status}
            outputSummary={item.outputSummary}
            onOpenDiff={
              diff
                ? () => {
                    setActiveDiff(diff);
                  }
                : undefined
            }
          />
        );
      }
      return (
        <MessageBubble
          role={item.role}
          text={item.text}
          streaming={item.streaming}
        />
      );
    },
    [diffsByTool],
  );

  if (!sessionId) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>未选择会话</Text>
        <Text style={styles.hint}>请从会话列表进入对话</Text>
        <Pressable
          style={styles.linkBtn}
          onPress={() => navigation.navigate('Sessions')}
        >
          <Text style={styles.linkBtnText}>返回会话列表</Text>
        </Pressable>
      </View>
    );
  }

  const canSend =
    draft.trim().length > 0 &&
    !sending &&
    !busy &&
    client !== null &&
    connStatus === 'authenticated';

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
    >
      <View style={styles.metaBar}>
        {model ? (
          <Text style={styles.metaText} numberOfLines={1}>
            {model}
          </Text>
        ) : (
          <Text style={styles.metaText}>—</Text>
        )}
        {busy ? (
          <Pressable
            onPress={onAbort}
            style={({ pressed }) => [
              styles.stopBtn,
              pressed && styles.stopBtnPressed,
            ]}
            accessibilityLabel="停止生成"
          >
            <Text style={styles.stopBtnText}>停止</Text>
          </Pressable>
        ) : null}
      </View>

      {error ? (
        <Pressable
          style={styles.errorBanner}
          onPress={() => {
            setError(null);
            void openSession();
          }}
        >
          <Text style={styles.errorText} numberOfLines={3}>
            {error}（点按重试）
          </Text>
        </Pressable>
      ) : null}

      {loading && timeline.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={styles.hint}>加载会话…</Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={timeline}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={
            timeline.length === 0 ? styles.emptyList : styles.list
          }
          onContentSizeChange={scrollToEnd}
          ListEmptyComponent={
            <View style={styles.centerPad}>
              <Text style={styles.emptyTitle}>开始对话</Text>
              <Text style={styles.hint}>输入消息，让 Agent 帮你操作工作区</Text>
            </View>
          }
        />
      )}

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder={busy ? '生成中…可点停止' : '输入消息…'}
          placeholderTextColor={theme.colors.textMuted}
          multiline
          maxLength={32_000}
          editable={!!client}
          onSubmitEditing={() => {
            if (canSend) void onSend();
          }}
          blurOnSubmit={false}
        />
        {busy ? (
          <Pressable
            style={({ pressed }) => [
              styles.abortBtn,
              pressed && styles.btnPressed,
            ]}
            onPress={onAbort}
            accessibilityLabel="停止"
          >
            <Text style={styles.abortBtnText}>停</Text>
          </Pressable>
        ) : (
          <Pressable
            style={({ pressed }) => [
              styles.sendBtn,
              !canSend && styles.sendBtnDisabled,
              pressed && canSend && styles.btnPressed,
            ]}
            onPress={() => {
              void onSend();
            }}
            disabled={!canSend}
            accessibilityLabel="发送"
          >
            {sending ? (
              <ActivityIndicator color={theme.colors.textInverse} size="small" />
            ) : (
              <Text style={styles.sendBtnText}>发送</Text>
            )}
          </Pressable>
        )}
      </View>

      <PermissionSheet
        visible={pendingPermission !== null}
        toolName={pendingPermission?.name ?? ''}
        risk={pendingPermission?.risk ?? 'medium'}
        input={pendingPermission?.input}
        responding={permissionResponding}
        onRespond={onPermissionRespond}
      />

      <DiffViewer
        visible={activeDiff !== null}
        path={activeDiff?.path ?? ''}
        unifiedDiff={activeDiff?.unifiedDiff ?? ''}
        onClose={() => setActiveDiff(null)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  headerRight: {
    marginRight: theme.spacing.sm,
  },
  chip: {
    paddingHorizontal: theme.spacing.sm + 2,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radius.full,
  },
  chipText: {
    fontSize: theme.fontSize.xs,
    fontWeight: '700',
  },
  metaBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  metaText: {
    flex: 1,
    fontSize: theme.fontSize.xs,
    color: theme.colors.textSecondary,
    marginRight: theme.spacing.sm,
  },
  stopBtn: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs + 2,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.dangerSoft,
    borderWidth: 1,
    borderColor: theme.colors.danger,
  },
  stopBtnPressed: {
    opacity: 0.85,
  },
  stopBtnText: {
    color: theme.colors.danger,
    fontWeight: '700',
    fontSize: theme.fontSize.sm,
  },
  errorBanner: {
    marginHorizontal: theme.spacing.md,
    marginTop: theme.spacing.sm,
    padding: theme.spacing.sm,
    backgroundColor: theme.colors.dangerSoft,
    borderRadius: theme.radius.sm,
  },
  errorText: {
    color: theme.colors.danger,
    fontSize: theme.fontSize.xs,
  },
  list: {
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
  },
  emptyList: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.lg,
  },
  centerPad: {
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
  linkBtn: {
    marginTop: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  linkBtnText: {
    color: theme.colors.primaryDark,
    fontWeight: '600',
    fontSize: theme.fontSize.sm,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: Platform.OS === 'ios' ? theme.spacing.sm + 2 : theme.spacing.sm,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceMuted,
    color: theme.colors.text,
    fontSize: theme.fontSize.md,
  },
  sendBtn: {
    minWidth: 64,
    height: 40,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primaryDark,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.md,
  },
  sendBtnDisabled: {
    opacity: 0.45,
  },
  sendBtnText: {
    color: theme.colors.textInverse,
    fontWeight: '700',
    fontSize: theme.fontSize.sm,
  },
  abortBtn: {
    minWidth: 48,
    height: 40,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.md,
  },
  abortBtnText: {
    color: theme.colors.textInverse,
    fontWeight: '700',
    fontSize: theme.fontSize.sm,
  },
  btnPressed: {
    opacity: 0.88,
  },
});
