'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AppBar,
  Avatar,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Drawer,
  IconButton,
  LinearProgress,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  Toolbar,
  Tooltip,
  Typography
} from '@mui/material';
import {
  AccountTreeOutlined,
  AssessmentOutlined,
  CloudUploadOutlined,
  DashboardOutlined,
  FactCheckOutlined,
  FindInPageOutlined,
  MenuOutlined,
  NotificationsNoneOutlined,
  RefreshOutlined,
  ScienceOutlined,
  SyncOutlined,
  TaskAltOutlined,
  WifiOffOutlined,
  WifiOutlined
} from '@mui/icons-material';
import {
  ISSUANCE_CHECK_DEFS,
  computeIssuanceGate,
  isVerificationCurrent,
  samplingStats,
  type CarbonRecord,
  type Mutation
} from '@/lib/domain';
import { useCarbonStore } from '@/lib/store';

const drawerWidth = 232;

type View = 'overview' | 'verify' | 'issuance';

const ACTORS = ['现场端 · 徐璐', '复核端 · 沈楠', '能源中心 · 韩跃'];

const fmtTime = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

function describeMutation(mutation: Mutation): string {
  switch (mutation.kind) {
    case 'revise-data':
      return `修订活动数据为 ${mutation.value.toLocaleString()}（基于 V${mutation.baseRevision}）`;
    case 'verify':
      return `核验通过（基于 V${mutation.baseRevision}）`;
    case 'start-review':
      return `退回复核（基于 V${mutation.baseRevision}）`;
    case 'finding':
      return mutation.action === 'request' ? `发现项 ${mutation.findingId} 发起补证` : `发现项 ${mutation.findingId} 关闭`;
    case 'issuance-check':
      return `签发检查 ${mutation.checkId} ${mutation.checked ? '确认' : '取消'}`;
    case 'sample':
      return `${mutation.sampled ? '抽取' : '移出'}样本 ${mutation.recordId}`;
    case 'sample-anomaly':
      return '按异常波动重抽样本';
    case 'submit-issuance':
      return '提交签发准备';
  }
}

/** 核验结果芯片：核验绑定数据版本，数据一变即显示失效 */
function VerificationChip({ record }: { record: CarbonRecord }) {
  if (isVerificationCurrent(record)) {
    return <Chip size="small" color="success" label={`已核验 @V${record.revision}`} />;
  }
  if (record.verification) {
    return (
      <Tooltip title={`原核验基于 V${record.verification.revision}（${record.verification.by}），数据已修订到 V${record.revision}，需重新核验`}>
        <Chip size="small" color="warning" variant="outlined" label={`核验失效 V${record.verification.revision}→V${record.revision}`} />
      </Tooltip>
    );
  }
  return <Chip size="small" variant="outlined" color={record.status === '需补证' ? 'warning' : 'default'} label={record.status} />;
}

export default function EvidenceWorkbench({ initialView }: { initialView: View }) {
  const [view] = useState<View>(initialView);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [recordFilter, setRecordFilter] = useState('全部');
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionValue, setCorrectionValue] = useState('');
  const [correctionReason, setCorrectionReason] = useState('');
  const [correctionBase, setCorrectionBase] = useState(0);
  const store = useCarbonStore();
  const snapshot = store.snapshot;

  useEffect(() => {
    void useCarbonStore.getState().load();
    const timer = setInterval(() => void useCarbonStore.getState().refreshSilent(), 4000);
    return () => clearInterval(timer);
  }, []);

  const records = useMemo(() => snapshot?.records ?? [], [snapshot]);
  const findings = useMemo(() => snapshot?.findings ?? [], [snapshot]);
  const gate = useMemo(() => (snapshot ? computeIssuanceGate(snapshot) : null), [snapshot]);
  const stats = useMemo(() => (snapshot ? samplingStats(snapshot) : null), [snapshot]);
  const selected = records.find((record) => record.id === store.selectedRecordId) ?? records[0];
  const visibleRecords = useMemo(
    () => (recordFilter === '全部' ? records : records.filter((record) => record.status === recordFilter)),
    [recordFilter, records]
  );
  const openFindings = findings.filter((item) => item.status !== '已关闭');
  const conflicts = store.outbox.filter((item) => item.status === 'conflict');
  const failedItems = store.outbox.filter((item) => item.status === 'failed');
  const pendingCount = store.outbox.filter((item) => item.status === 'pending' || item.status === 'saving').length;
  const recentOutbox = store.outbox.slice(-6).reverse();
  const verifiedCount = records.filter(isVerificationCurrent).length;

  const nav = [
    { id: 'overview', label: '监测期总览', href: '/', icon: DashboardOutlined },
    { id: 'verify', label: '证据与抽样核验', href: '/verify', icon: FindInPageOutlined },
    { id: 'issuance', label: '签发准备', href: '/issuance', icon: AssessmentOutlined }
  ];

  const openCorrection = (record: CarbonRecord) => {
    // 记录打开对话框时的版本号，提交时以此作为乐观并发基准
    setCorrectionBase(record.revision);
    setCorrectionValue(String(record.activity));
    setCorrectionReason('');
    setCorrectionOpen(true);
  };

  const submitCorrection = () => {
    if (!selected) return;
    store.enqueue(`修订 ${selected.id} 活动数据`, {
      kind: 'revise-data',
      recordId: selected.id,
      baseRevision: correctionBase,
      value: Number(correctionValue),
      reason: correctionReason
    });
    setCorrectionOpen(false);
    setCorrectionReason('');
  };

  const batchVerify = () => {
    if (!snapshot) return;
    const targets = snapshot.records.filter(
      (record) => snapshot.sampledIds.includes(record.id) && !isVerificationCurrent(record) && record.status !== '需补证'
    );
    if (targets.length === 0) return;
    for (const record of targets) {
      store.enqueue(`核验 ${record.id}`, { kind: 'verify', recordId: record.id, baseRevision: record.revision });
    }
  };

  const navDrawer = (
    <Box sx={{ width: drawerWidth, bgcolor: '#f8faf9', height: '100%' }}>
      <Box sx={{ p: 2.2, pt: 3 }}>
        <Typography variant="overline" color="text.secondary">当前项目</Typography>
        <Typography fontWeight={800} fontSize={13} mt={.5}>{snapshot?.project.name ?? '临港工业园区能效提升项目'}</Typography>
        <Typography variant="caption" color="text.secondary">{snapshot?.project.id ?? 'CN-ER-2026-041'}</Typography>
      </Box>
      <Divider />
      <List sx={{ px: 1, py: 1.2 }}>
        {nav.map(({ id, label, href, icon: Icon }) => (
          <ListItemButton key={id} component={Link} href={href} selected={view === id} sx={{ borderRadius: 1, mb: .4, '&.Mui-selected': { bgcolor: '#e4f1ec', color: '#12664f' } }}>
            <ListItemIcon sx={{ minWidth: 36, color: 'inherit' }}><Icon fontSize="small" /></ListItemIcon>
            <ListItemText primary={label} primaryTypographyProps={{ fontSize: 13, fontWeight: view === id ? 750 : 500 }} />
          </ListItemButton>
        ))}
      </List>
      <Box sx={{ p: 2, mt: 2 }}>
        <Box sx={{ p: 1.3, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: 'white' }}>
          <Stack direction="row" alignItems="center" spacing={1} mb={1}><ScienceOutlined color="primary" fontSize="small" /><Typography fontSize={12} fontWeight={750}>核验状态</Typography></Stack>
          <LinearProgress variant="determinate" value={records.length ? (verifiedCount / records.length) * 100 : 0} sx={{ height: 5, borderRadius: 2 }} />
          <Typography variant="caption" color="text.secondary" display="block" mt={1}>
            {verifiedCount}/{records.length} 条记录核验对当前版本有效
          </Typography>
        </Box>
      </Box>
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <AppBar position="fixed" elevation={0} sx={{ zIndex: (theme) => theme.zIndex.drawer + 1, bgcolor: '#173a31', borderBottom: '1px solid rgba(255,255,255,.12)' }}>
        <Toolbar sx={{ minHeight: '62px !important', gap: 1.4 }}>
          <IconButton color="inherit" sx={{ display: { md: 'none' } }} onClick={() => setMobileOpen(true)}><MenuOutlined /></IconButton>
          <Box sx={{ width: 36, height: 36, borderRadius: 1, border: '1px solid #80b6a6', display: 'grid', placeItems: 'center' }}>
            <AccountTreeOutlined fontSize="small" />
          </Box>
          <Box>
            <Typography fontSize={15} fontWeight={800}>碳减排项目监测核验</Typography>
            <Typography fontSize={10} color="#a9c5bc">MRV Evidence & Issuance Readiness</Typography>
          </Box>
          <Box sx={{ flex: 1 }} />
          {snapshot && (
            <Chip
              size="small"
              variant="outlined"
              label={`数据纪元 #${snapshot.dataEpoch} · 链高 #${snapshot.chainSeq}`}
              sx={{ color: '#b9d6cc', borderColor: '#3f6a5d', bgcolor: 'rgba(255,255,255,.05)', display: { xs: 'none', lg: 'flex' } }}
            />
          )}
          {pendingCount > 0 && <Chip size="small" icon={<SyncOutlined />} label={`同步中 ${pendingCount}`} sx={{ color: '#cfe8de', borderColor: '#3f6a5d' }} variant="outlined" />}
          {failedItems.length > 0 && (
            <Chip
              size="small"
              color="error"
              label={`${failedItems.length} 条未确认 · 点击重试`}
              onClick={store.retryUnconfirmed}
              sx={{ cursor: 'pointer' }}
            />
          )}
          {conflicts.length > 0 && <Chip size="small" color="warning" label={`${conflicts.length} 个版本冲突`} />}
          <Select
            size="small"
            value={store.actor}
            onChange={(event) => store.setActor(event.target.value)}
            sx={{ color: '#e7f2ed', fontSize: 12, height: 32, '& .MuiOutlinedInput-notchedOutline': { borderColor: '#3f6a5d' }, '& .MuiSvgIcon-root': { color: '#9fc2b6' } }}
          >
            {ACTORS.map((actor) => <MenuItem key={actor} value={actor} sx={{ fontSize: 12 }}>{actor}</MenuItem>)}
          </Select>
          <Tooltip title={store.online ? '当前在线；点击模拟断网，验证批次中断后只重试未确认记录' : '模拟断网中；点击恢复在线'}>
            <Chip
              size="small"
              icon={store.online ? <WifiOutlined /> : <WifiOffOutlined />}
              label={store.online ? '在线' : '模拟断网'}
              variant="outlined"
              onClick={store.toggleOnline}
              sx={{ cursor: 'pointer', color: store.online ? '#b9d6cc' : '#ffcda8', borderColor: store.online ? '#3f6a5d' : '#a87935' }}
            />
          </Tooltip>
          <Chip size="small" label={`${openFindings.length} 项发现开放`} sx={{ color: '#ffdda7', borderColor: '#a87935', bgcolor: 'rgba(255,255,255,.05)' }} variant="outlined" />
          <IconButton color="inherit"><NotificationsNoneOutlined /></IconButton>
          <Avatar sx={{ width: 30, height: 30, bgcolor: '#e1a45d', fontSize: 12 }}>{store.actor.slice(-1)}</Avatar>
        </Toolbar>
      </AppBar>
      <Drawer variant="permanent" sx={{ width: drawerWidth, flexShrink: 0, display: { xs: 'none', md: 'block' }, '& .MuiDrawer-paper': { width: drawerWidth, pt: '62px', boxSizing: 'border-box', borderRightColor: '#dce4e0' } }}>{navDrawer}</Drawer>
      <Drawer variant="temporary" open={mobileOpen} onClose={() => setMobileOpen(false)} ModalProps={{ keepMounted: true }} sx={{ display: { xs: 'block', md: 'none' }, '& .MuiDrawer-paper': { width: drawerWidth, pt: '62px' } }}>{navDrawer}</Drawer>

      <Box component="main" sx={{ flexGrow: 1, minWidth: 0, bgcolor: '#f2f5f3', pt: '62px' }}>
        <Box sx={{ p: { xs: 1.5, md: 3 }, maxWidth: 1640, mx: 'auto' }}>
          <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" alignItems={{ xs: 'flex-start', md: 'center' }} spacing={2} mb={2.4}>
            <Box>
              <Typography variant="overline" color="text.secondary" fontWeight={750}>{snapshot?.project.id ?? 'CN-ER-2026-041'} / {snapshot?.period ?? '第三监测期'}</Typography>
              <Typography variant="h5" fontWeight={850} mt={.3}>{view === 'overview' ? '监测期总览' : view === 'verify' ? '证据与抽样核验' : '签发准备'}</Typography>
              <Typography variant="body2" color="text.secondary" mt={.5}>
                {view === 'overview' ? '汇总活动数据、排放因子、证据完整度和异常波动。' : view === 'verify' ? '逐项核对来源、单位、时间范围；核验结果绑定数据版本。' : '关闭发现项并完成签发前完整性门禁。'}
              </Typography>
            </Box>
            <Stack direction="row" spacing={1}>
              <Button variant="outlined" startIcon={<CloudUploadOutlined />}>导入监测数据</Button>
              <Tooltip title={gate && !gate.ready ? `还有 ${gate.gaps.length} 项缺口，详见签发准备页` : ''}>
                <span>
                  <Button
                    variant="contained"
                    startIcon={<TaskAltOutlined />}
                    disabled={view !== 'issuance' || !gate?.ready || Boolean(snapshot?.submittedAt)}
                    onClick={() => store.enqueue('提交签发准备', { kind: 'submit-issuance' })}
                  >
                    {snapshot?.submittedAt ? '已提交签发准备' : '提交签发准备'}
                  </Button>
                </span>
              </Tooltip>
            </Stack>
          </Stack>
          {!snapshot && <LinearProgress />}

          {conflicts.length > 0 && (
            <Alert severity="error" sx={{ mb: 2 }} icon={<FactCheckOutlined />}>
              <Typography fontSize={13} fontWeight={800} mb={1}>版本冲突：他人已先保存，你的修改未覆盖服务端数据</Typography>
              {conflicts.map((item) => (
                <Box key={item.clientId} sx={{ borderTop: '1px solid rgba(0,0,0,.08)', py: 1 }}>
                  <Typography fontSize={12} fontWeight={700}>{item.label}</Typography>
                  {item.conflictLatest && (
                    <Typography fontSize={11.5} mt={.3}>
                      服务端最新：{item.conflictLatest.activity.toLocaleString()} {item.conflictLatest.unit}（V{item.conflictLatest.revision}）
                      {'　'}你的冲突副本：{describeMutation(item.mutation)}
                    </Typography>
                  )}
                  <Stack direction="row" spacing={1} mt={.8}>
                    <Button size="small" variant="contained" onClick={() => store.rebaseConflict(item.clientId)}>基于最新版本重新提交</Button>
                    <Button size="small" onClick={() => store.discardItem(item.clientId)}>放弃我的修改</Button>
                  </Stack>
                </Box>
              ))}
            </Alert>
          )}

          {view === 'overview' && snapshot && stats && (
            <>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', lg: 'repeat(4, 1fr)' }, gap: 1.4, mb: 2 }}>
                {[
                  { label: '减排量', value: (store.summary?.reduction ?? 0).toLocaleString(), unit: 'tCO₂e', note: '随数据修订实时重算' },
                  { label: '证据完整度', value: `${store.summary?.evidenceRate ?? 0}%`, unit: '', note: '按来源证据份数统计' },
                  { label: '开放发现项', value: `${openFindings.length}`, unit: '项', note: openFindings.length ? '阻塞签发提交' : '已全部关闭' },
                  { label: '抽样任务', value: `${stats.verified} / ${stats.total}`, unit: '', note: stats.stale ? `${stats.stale} 条核验已失效待重核` : '抽样核验对当前版本有效' }
                ].map((item) => <Card elevation={0} variant="outlined" key={item.label}><CardContent sx={{ p: 1.8, '&:last-child': { pb: 1.8 } }}><Typography variant="caption" color="text.secondary">{item.label}</Typography><Stack direction="row" alignItems="baseline" spacing={.6} mt={.5}><Typography variant="h5" fontWeight={850}>{item.value}</Typography><Typography fontSize={12} color="text.secondary">{item.unit}</Typography></Stack><Typography fontSize={11} color="text.secondary" mt={.7}>{item.note}</Typography></CardContent></Card>)}
              </Box>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: 'minmax(0, 1.55fr) minmax(300px, .7fr)' }, gap: 1.5 }}>
                <Card elevation={0} variant="outlined">
                  <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ p: 1.6 }}>
                    <Box><Typography fontWeight={800} fontSize={14}>活动数据与计算链</Typography><Typography fontSize={11} color="text.secondary">选择记录查看公式、来源证据和修订版本</Typography></Box>
                    <Tabs value={recordFilter} onChange={(_, value) => setRecordFilter(value)} variant="scrollable"><Tab value="全部" label="全部" /><Tab value="待核验" label="待核验" /><Tab value="需补证" label="需补证" /><Tab value="已核验" label="已核验" /></Tabs>
                  </Stack>
                  <Divider />
                  <Box sx={{ overflowX: 'auto' }}>
                    <Box sx={{ minWidth: 900 }}>
                      <Box sx={{ display: 'grid', gridTemplateColumns: '1.7fr .9fr .8fr 1fr .6fr 1fr', gap: 1, px: 1.7, py: 1, bgcolor: '#f7f9f8', color: 'text.secondary', fontSize: 11, fontWeight: 750 }}>
                        <span>数据来源</span><span>活动数据</span><span>排放因子</span><span>时间范围</span><span>证据</span><span>核验状态</span>
                      </Box>
                      {visibleRecords.map((record) => (
                        <Box key={record.id} role="button" tabIndex={0} onClick={() => store.selectRecord(record.id)} sx={{ display: 'grid', gridTemplateColumns: '1.7fr .9fr .8fr 1fr .6fr 1fr', gap: 1, px: 1.7, py: 1.25, borderTop: '1px solid #e8ecea', cursor: 'pointer', bgcolor: selected?.id === record.id ? '#eff7f3' : 'white', '&:hover': { bgcolor: '#f6faf8' } }}>
                          <Box><Typography fontSize={12.5} fontWeight={700}>{record.source}</Typography><Typography fontSize={10} color="text.secondary">{record.id} · {record.owner} · V{record.revision}</Typography></Box>
                          <Box><Typography fontSize={12}>{record.activity.toLocaleString()} {record.unit}</Typography><Typography fontSize={10} color={Math.abs(record.anomaly) > 5 ? 'secondary.main' : 'text.secondary'}>异常 {record.anomaly > 0 ? '+' : ''}{record.anomaly}%</Typography></Box>
                          <Typography fontSize={12}>{record.factor} <small>{record.factorUnit}</small></Typography>
                          <Typography fontSize={11}>{record.timeRange}</Typography>
                          <Typography fontSize={12}>{record.evidenceCount} 项</Typography>
                          <Box><VerificationChip record={record} /></Box>
                        </Box>
                      ))}
                    </Box>
                  </Box>
                </Card>
                <Stack spacing={1.5}>
                  {selected && (
                    <Card elevation={0} variant="outlined"><CardContent><Stack direction="row" justifyContent="space-between" alignItems="center"><Typography fontWeight={800} fontSize={14}>计算链展开</Typography><Chip size="small" label={`${selected.id} · V${selected.revision}`} /></Stack><Box sx={{ mt: 1.5, p: 1.3, bgcolor: '#f4f7f5', fontFamily: 'monospace', borderRadius: 1, fontSize: 11 }}>
                      <Box>活动数据 = {selected.activity.toLocaleString()} {selected.unit}</Box>
                      <Box mt={.6}>排放因子 = {selected.factor} {selected.factorUnit}</Box>
                      <Box mt={.6}>换算系数 = 0.001</Box>
                      <Divider sx={{ my: 1 }} />
                      <Box sx={{ color: '#14644f', fontWeight: 800 }}>减排量 = {(selected.activity * selected.factor / 1000).toFixed(2)} tCO₂e</Box>
                    </Box><Stack direction="row" spacing={1} mt={1.5}><Button size="small" variant="outlined" onClick={() => openCorrection(selected)}>修订数据</Button><Button size="small">查看证据</Button></Stack>
                      {selected.verification && !isVerificationCurrent(selected) && (
                        <Alert severity="warning" sx={{ mt: 1.5 }}>V{selected.verification.revision} 的核验结果已随数据修订失效，抽样统计与签发门禁已重算。</Alert>
                      )}
                    </CardContent></Card>
                  )}
                  <Card elevation={0} variant="outlined"><CardContent><Typography fontWeight={800} fontSize={14} mb={1.2}>核验发现项</Typography>{openFindings.slice(0, 3).map((finding) => <Box key={finding.id} sx={{ py: 1, borderTop: '1px solid #edf0ef' }}><Stack direction="row" spacing={1}><Alert severity={finding.status === '补证中' ? 'warning' : 'error'} sx={{ p: .2, '& .MuiAlert-icon': { mr: .3, fontSize: 17 } }} /><Box><Typography fontSize={12} fontWeight={700}>{finding.title}</Typography><Typography fontSize={10} color="text.secondary" mt={.3}>{finding.assignee} · {finding.due}{finding.note ? ` · ${finding.note}` : ''}</Typography></Box></Stack></Box>)}{openFindings.length === 0 && <Typography fontSize={12} color="text.secondary">发现项已全部关闭。</Typography>}</CardContent></Card>
                </Stack>
              </Box>
            </>
          )}

          {view === 'verify' && snapshot && stats && (
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: 'minmax(0, 1fr) 340px' }, gap: 1.5 }}>
              <Card elevation={0} variant="outlined">
                <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }} spacing={1} sx={{ p: 1.6 }}>
                  <Box>
                    <Typography fontWeight={800} fontSize={14}>证据矩阵与抽样任务</Typography>
                    <Typography fontSize={11} color="text.secondary">
                      已抽取 {stats.total} 条 · 核验有效 {stats.verified} 条{stats.stale > 0 ? ` · ${stats.stale} 条核验失效待重核` : ''}
                    </Typography>
                  </Box>
                  <Stack direction="row" spacing={1}>
                    {failedItems.length > 0 && <Button variant="outlined" color="error" startIcon={<RefreshOutlined />} onClick={store.retryUnconfirmed}>重试未确认（{failedItems.length}）</Button>}
                    <Button variant="outlined" onClick={() => store.enqueue('按异常波动抽样', { kind: 'sample-anomaly', ids: stats.highAnomalyIds })}>按异常抽样</Button>
                    <Button variant="contained" onClick={batchVerify}>批量核验</Button>
                  </Stack>
                </Stack><Divider />
                {snapshot.records.map((record) => (
                  <Box key={record.id} sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '22px minmax(210px, 1.3fr) .8fr .8fr .9fr auto' }, alignItems: 'center', gap: 1.2, px: 1.6, py: 1.3, borderTop: '1px solid #edf0ef' }}>
                    <input
                      type="checkbox"
                      checked={snapshot.sampledIds.includes(record.id)}
                      onChange={() => store.enqueue(`${snapshot.sampledIds.includes(record.id) ? '移出样本' : '抽取样本'} ${record.id}`, { kind: 'sample', recordId: record.id, sampled: !snapshot.sampledIds.includes(record.id) })}
                      aria-label={`抽样 ${record.id}`}
                    />
                    <Box><Typography fontSize={12.5} fontWeight={700}>{record.source}</Typography><Typography fontSize={10} color="text.secondary">{record.id} · 证据 {record.evidenceCount} 份 · V{record.revision}</Typography></Box>
                    <Box><Typography variant="caption" color="text.secondary">来源</Typography><Typography fontSize={11}>原始计量记录</Typography></Box>
                    <Box><Typography variant="caption" color="text.secondary">单位</Typography><Typography fontSize={11}>{record.unit} / {record.factorUnit}</Typography></Box>
                    <Box><Typography variant="caption" color="text.secondary">核验状态</Typography><Box mt={.3}><VerificationChip record={record} /></Box></Box>
                    <Stack direction="row" spacing={.7}>
                      <Button size="small" variant="outlined" onClick={() => store.enqueue(`复核 ${record.id}`, { kind: 'start-review', recordId: record.id, baseRevision: record.revision })}>复核</Button>
                      <Button size="small" variant="contained" disabled={record.status === '需补证' || isVerificationCurrent(record)} onClick={() => store.enqueue(`核验 ${record.id}`, { kind: 'verify', recordId: record.id, baseRevision: record.revision })}>通过</Button>
                    </Stack>
                  </Box>
                ))}
              </Card>
              <Stack spacing={1.5}>
                <Card elevation={0} variant="outlined"><CardContent><Typography fontWeight={800} fontSize={14} mb={1.3}>发现项闭环</Typography>{findings.map((finding) => (
                  <Box key={finding.id} sx={{ borderTop: '1px solid #edf0ef', py: 1.2 }}>
                    <Stack direction="row" justifyContent="space-between"><Typography fontSize={12} fontWeight={700}>{finding.title}</Typography><Chip size="small" label={finding.status} color={finding.status === '已关闭' ? 'success' : finding.status === '补证中' ? 'warning' : 'error'} /></Stack>
                    <Typography fontSize={10.5} color="text.secondary" mt={.5}>{finding.detail}</Typography>
                    {finding.note && <Alert severity="warning" sx={{ mt: .8, py: 0 }}>{finding.note}</Alert>}
                    <Stack direction="row" spacing={.7} mt={1}>
                      <Button size="small" disabled={finding.status === '已关闭'} onClick={() => store.enqueue(`发现项 ${finding.id} 发起补证`, { kind: 'finding', findingId: finding.id, action: 'request' })}>发起补证</Button>
                      <Button size="small" disabled={finding.status === '已关闭'} onClick={() => store.enqueue(`发现项 ${finding.id} 关闭`, { kind: 'finding', findingId: finding.id, action: 'close' })}>关闭</Button>
                    </Stack>
                  </Box>))}
                </CardContent></Card>
                <Card elevation={0} variant="outlined">
                  <CardContent>
                    <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
                      <Typography fontWeight={800} fontSize={14}>写入队列</Typography>
                      {store.outbox.some((item) => item.status === 'confirmed') && <Button size="small" onClick={store.clearConfirmed}>清除已确认</Button>}
                    </Stack>
                    {recentOutbox.length === 0 && <Typography fontSize={12} color="text.secondary">暂无待写入操作。所有变更按打开页面时的版本号提交，先到者得。</Typography>}
                    {recentOutbox.map((item) => (
                      <Box key={item.clientId} sx={{ borderTop: '1px solid #edf0ef', py: .9 }}>
                        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                          <Typography fontSize={11.5} fontWeight={600}>{item.label}</Typography>
                          <Chip
                            size="small"
                            label={item.status === 'confirmed' ? '已生效' : item.status === 'saving' ? '写入中' : item.status === 'pending' ? '待写入' : item.status === 'conflict' ? '版本冲突' : '未确认'}
                            color={item.status === 'confirmed' ? 'success' : item.status === 'conflict' ? 'warning' : item.status === 'failed' ? 'error' : 'default'}
                            variant={item.status === 'pending' || item.status === 'saving' ? 'outlined' : 'filled'}
                          />
                        </Stack>
                        {item.error && <Typography fontSize={10.5} color="error.main" mt={.3}>{item.error}</Typography>}
                        {item.gaps && <Typography fontSize={10.5} color="error.main" mt={.3}>缺口：{item.gaps.slice(0, 2).join('；')}{item.gaps.length > 2 ? ` 等 ${item.gaps.length} 项` : ''}</Typography>}
                      </Box>
                    ))}
                  </CardContent>
                </Card>
                <Alert severity="info">任何数据修订都会生成新版本并推进版本链，旧核验、抽样统计与签发勾选随之失效重算，原始提交不会被覆盖。</Alert>
              </Stack>
            </Box>
          )}

          {view === 'issuance' && snapshot && gate && (
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) 380px' }, gap: 1.5 }}>
              <Card elevation={0} variant="outlined">
                <CardContent>
                  <Typography fontWeight={800} fontSize={14}>签发前完整性检查</Typography>
                  <Typography fontSize={11} color="text.secondary" mb={1.5}>检查项绑定数据纪元 #{snapshot.dataEpoch}；活动数据一变，旧勾选自动失效需重新确认。</Typography>
                  {ISSUANCE_CHECK_DEFS.map((def) => {
                    const check = snapshot.issuanceChecks.find((item) => item.id === def.id);
                    const effective = Boolean(check && check.checked && check.dataEpoch === snapshot.dataEpoch);
                    const stale = Boolean(check && check.checked && check.dataEpoch !== snapshot.dataEpoch);
                    return (
                      <Box key={def.id} component="label" sx={{ display: 'flex', gap: 1.3, alignItems: 'flex-start', borderTop: '1px solid #edf0ef', py: 1.5, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={effective}
                          onChange={() => store.enqueue(`签发检查「${def.title}」${effective ? '取消' : '确认'}`, { kind: 'issuance-check', checkId: def.id, checked: !effective })}
                        />
                        <Box>
                          <Stack direction="row" spacing={.8} alignItems="center">
                            <Typography fontSize={12.5} fontWeight={700}>{def.title}</Typography>
                            {stale && <Chip size="small" color="warning" variant="outlined" label={`原确认基于纪元 #${check?.dataEpoch}，已失效`} />}
                          </Stack>
                          <Typography fontSize={10.5} color="text.secondary" mt={.4}>{def.detail}{check?.by && effective ? ` 由 ${check.by} 于 ${fmtTime(check.at ?? '')} 确认。` : ''}</Typography>
                        </Box>
                      </Box>
                    );
                  })}
                </CardContent>
              </Card>
              <Stack spacing={1.5}>
                <Card elevation={0} variant="outlined"><CardContent><Typography fontWeight={800} fontSize={14}>签发就绪度</Typography><Stack direction="row" alignItems="baseline" spacing={1} mt={1}><Typography variant="h4" fontWeight={850}>{gate.readiness}%</Typography><Typography fontSize={11} color="text.secondary">完成度</Typography></Stack><LinearProgress variant="determinate" value={gate.readiness} sx={{ height: 7, borderRadius: 3, mt: 1 }} /><Typography fontSize={11} color="text.secondary" mt={1.2}>还有 {openFindings.length} 个开放发现项，{records.length - verifiedCount} 条记录核验未完成或已失效。</Typography></CardContent></Card>
                {snapshot.submittedAt ? (
                  <Alert severity="success">签发准备已于 {fmtTime(snapshot.submittedAt)} 提交（数据纪元 #{snapshot.dataEpoch}）。后续数据修订将使提交失效并重新开放门禁。</Alert>
                ) : gate.ready ? (
                  <Alert severity="success">全部门禁已完成，可提交签发准备。</Alert>
                ) : (
                  <Alert severity="warning">
                    <Typography fontSize={12.5} fontWeight={800} mb={.6}>暂不能提交，缺口如下：</Typography>
                    {gate.gaps.map((gap) => <Typography key={gap} fontSize={11.5} mt={.3}>· {gap}</Typography>)}
                  </Alert>
                )}
                <Card elevation={0} variant="outlined"><CardContent>
                  <Typography fontWeight={800} fontSize={14} mb={.5}>监测期版本链</Typography>
                  <Typography fontSize={10.5} color="text.secondary" mb={1}>核验、发现项与签发准备全部写入同一条链，当前链高 #{snapshot.chainSeq}。</Typography>
                  {[...snapshot.chain].reverse().slice(0, 8).map((event) => (
                    <Stack key={event.seq} direction="row" spacing={1.2} sx={{ borderTop: '1px solid #edf0ef', py: 1.2 }}>
                      <Chip size="small" label={`#${event.seq}`} color={event.kind === '数据修订' ? 'warning' : 'default'} variant={event.kind === '数据修订' ? 'filled' : 'outlined'} />
                      <Box>
                        <Typography fontSize={11.5} fontWeight={700}>{event.actor} · {event.kind} · {fmtTime(event.at)}</Typography>
                        <Typography fontSize={10.5} color="text.secondary">{event.summary}</Typography>
                      </Box>
                    </Stack>
                  ))}
                </CardContent></Card>
              </Stack>
            </Box>
          )}
        </Box>
      </Box>

      <Tooltip title="核验记录会写入审计链"><Button sx={{ position: 'fixed', bottom: 18, right: 18, zIndex: 5 }} variant="contained" size="small" startIcon={<FactCheckOutlined />}>操作均留痕</Button></Tooltip>
      {correctionOpen && selected && (
        <Box sx={{ position: 'fixed', inset: 0, zIndex: 60, bgcolor: 'rgba(15,25,22,.4)', display: 'grid', placeItems: 'center', p: 2 }} onMouseDown={() => setCorrectionOpen(false)}>
          <Card sx={{ width: 'min(520px, 100%)' }} onMouseDown={(event) => event.stopPropagation()}><CardContent sx={{ p: 2.2 }}>
            <Typography variant="h6" fontWeight={800}>修订活动数据</Typography>
            <Typography variant="body2" color="text.secondary" mt={.5}>
              当前值 {selected.activity.toLocaleString()} {selected.unit}（服务端 V{selected.revision}）。提交将基于你打开时的 V{correctionBase} 校验版本；若他人已先保存，你会收到最新值与冲突副本，不会覆盖对方修订。
            </Typography>
            <TextField fullWidth size="small" label={`修订值 / ${selected.unit}`} value={correctionValue} onChange={(event) => setCorrectionValue(event.target.value)} margin="normal" />
            <TextField fullWidth size="small" label="修订原因" multiline rows={3} value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} margin="normal" />
            {!correctionReason.trim() && <Alert severity="warning">必须填写修订原因。</Alert>}
            <Alert severity="info" sx={{ mt: 1 }}>修订生效后：旧核验结果与抽样统计失效重算，关联发现项退回处理，签发门禁按新版本重算。</Alert>
            <Stack direction="row" spacing={1} justifyContent="flex-end" mt={2}><Button onClick={() => setCorrectionOpen(false)}>取消</Button><Button variant="contained" disabled={!correctionReason.trim() || !Number(correctionValue)} onClick={submitCorrection}>生成新版本</Button></Stack>
          </CardContent></Card>
        </Box>
      )}
    </Box>
  );
}
