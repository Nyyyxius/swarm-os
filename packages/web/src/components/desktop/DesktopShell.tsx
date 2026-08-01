// packages/web/src/components/desktop/DesktopShell.tsx
//
// Pure presentation. All live state + operator handlers were lifted into
// `SwarmControllerProvider` (controller/SwarmController.tsx) so the single
// `useEvents()` WebSocket survives the desktop↔mobile shell swap and there
// is never a transient duplicate consumer (regression-guard 584d9ec). This
// component now just reads `useSwarmController()` and renders the desktop
// grid — its behaviour is identical to the pre-mobile shell.
import TopBar from './TopBar';
import LeftPanel from './LeftPanel';
import MapView from './MapView';
import RightPanel from './RightPanel';
import Toasts from './Toasts';
import EventsPip from './EventsPip';
import SettingsDrawer from './SettingsDrawer';
import { NewOrchestratorDialog } from '../NewOrchestratorDialog';
import BroadcastModal from './BroadcastModal';
import SpawnWorkerDialog from './SpawnWorkerDialog';
import EditConfigDialog from './EditConfigDialog';
import { useSwarmController } from '../../controller/SwarmController';

export default function DesktopShell() {
  const c = useSwarmController();

  return (
    <div className="app">
      <TopBar
        teams={c.topBarTeams}
        selectedTeamId={c.selectedTeamId}
        flashTeamIds={c.flashTeamIds}
        totalAgents={c.totalAgents}
        info={c.topBarInfo}
        onSelectTeam={c.handleSelectTeam}
        onNewTeam={() => c.setShowNew(true)}
        onOpenRoles={c.onOpenRoles}
        onOpenMemory={c.onOpenMemory}
        onOpenBoard={c.onOpenBoard}
        onOpenApprovals={c.onOpenApprovals}
        onOpenPlugins={c.onOpenPlugins}
        onOpenIde={c.onOpenIde}
        onOpenSettings={() => c.setSettingsOpen(true)}
        onOpenUpdates={c.openUpdates}
      />
      <div className="main">
        <LeftPanel
          orchestrators={c.orchestrators}
          onSelectTeam={c.handleLeftSelectTeam}
          onSelectEnded={c.handleLeftSelectEnded}
        />
        <MapView
          teams={c.mapViewTeams}
          selectedId={c.selectedSessionId}
          onSelect={c.selectAgent}
          onBroadcast={() => c.setBroadcastOpen(true)}
          pulses={c.pulses}
          spawningIds={c.spawningIds}
        />
        <RightPanel
          selected={c.selectedAgent}
          team={c.selectedTeam}
          isLead={c.isLead}
          messages={c.messages}
          activeTab={c.activeTab}
          setActiveTab={c.setActiveTab}
          onClose={c.closeRightPanel}
          onAction={c.onAction}
          onSend={c.onSend}
          onSpawnWorker={c.handleSpawnWorker}
          onEditConfig={c.handleEditConfig}
          onTerminalRoleChange={c.onTerminalRoleChange}
          onTerminalDataFrame={c.onTerminalDataFrame}
        />
      </div>

      <NewOrchestratorDialog
        open={c.showNew}
        onClose={() => c.setShowNew(false)}
        onCreate={c.handleCreateOrchestrator}
      />
      {c.settingsOpen && (
        <SettingsDrawer
          info={c.info}
          health={c.health}
          authState={c.authState}
          wsConnected={c.eventsConnected}
          onClose={() => c.setSettingsOpen(false)}
          onTokenSaved={() => { void c.probeAuth(); }}
          onTokenCleared={c.setAuthMissing}
          shellMode={c.shellMode}
          setShellMode={c.setShellMode}
          focusUpdates={c.updatesFocus}
        />
      )}
      <BroadcastModal
        open={c.broadcastOpen}
        orchestrators={c.orchestrators}
        onClose={() => c.setBroadcastOpen(false)}
      />
      <SpawnWorkerDialog
        open={c.spawnFor !== null}
        team={c.spawnFor}
        roles={c.roles}
        onClose={() => c.setSpawnFor(null)}
        onSpawn={c.handleSpawnWorkerSubmit}
      />
      <EditConfigDialog
        open={c.editConfigFor !== null}
        team={c.editConfigFor}
        onClose={() => c.setEditConfigFor(null)}
      />

      {c.waitingToasts.length > 0 || c.approvalToasts.length > 0 ? (
        <Toasts
          items={c.waitingToasts}
          onOpen={c.handleToastOpen}
          onDismiss={c.dismissToast}
          panelOpen={c.panelOpen}
          approvals={c.approvalToasts}
          onApprove={c.approveApproval}
          onDeny={c.denyApproval}
          onApprovalOpen={c.handleApprovalOpen}
          onApprovalDismiss={c.dismissApprovalToast}
        />
      ) : (
        <EventsPip connected={c.eventsConnected} panelOpen={c.panelOpen} />
      )}
    </div>
  );
}
