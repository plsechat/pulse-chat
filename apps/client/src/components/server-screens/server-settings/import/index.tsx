import { LoadingCard } from '@/components/ui/loading-card';
import { useActiveServerId } from '@/features/app/hooks';
import { useImportWizard } from '@/features/server/import/hooks';
import { memo } from 'react';
import { QueryErrorRow } from '../query-state';
import { ChooseStep } from './choose-step';
import { ConnectStep } from './connect-step';
import { DoneStep } from './done-step';
import { ImportedPeople } from './imported-people';
import { OptionsStep } from './options-step';
import { PreviewStep } from './preview-step';
import { RunningStep } from './running-step';
import { Stepper } from './stepper';

/**
 * Server Settings → Import. Six cards, one at a time; the step is
 * derived from the job on the server, so reopening the screen lands
 * where the owner left off. The settings shell shows this section to
 * the server owner only.
 */
const Import = memo(() => {
  const serverId = useActiveServerId();
  const wizard = useImportWizard(serverId);

  if (serverId === undefined) return null;

  if (wizard.loading) {
    return <LoadingCard className="h-64" />;
  }

  if (wizard.loadError) {
    return <QueryErrorRow message={wizard.loadError} onRetry={wizard.refresh} />;
  }

  const { job } = wizard;

  return (
    <div className="space-y-4">
      <Stepper current={wizard.step} />

      {wizard.step === 'connect' && (
        <ConnectStep
          serverId={serverId}
          job={job && job.status === 'pending' ? job : null}
          busy={wizard.busy === 'connect'}
          onConnect={wizard.connect}
          onNext={wizard.goToChoose}
        />
      )}

      {wizard.step === 'choose' && (
        <ChooseStep
          guilds={wizard.guilds}
          busy={wizard.busy}
          onLoad={wizard.loadGuilds}
          onChoose={wizard.choose}
          onBack={wizard.startOver}
        />
      )}

      {wizard.step === 'preview' && job && (
        <PreviewStep
          job={job}
          preview={wizard.preview}
          busy={wizard.busy}
          onReload={() => (job.guild ? wizard.choose(job.guild.id) : Promise.resolve())}
          onBack={wizard.goToChoose}
          onNext={wizard.goToOptions}
        />
      )}

      {wizard.step === 'options' && (
        <OptionsStep
          options={wizard.options}
          preview={wizard.preview}
          busy={wizard.busy}
          onChange={wizard.setOptions}
          onBack={wizard.goToPreview}
          onStart={wizard.start}
        />
      )}

      {wizard.step === 'running' && job && (
        <RunningStep
          job={job}
          busy={wizard.busy}
          onPause={wizard.pause}
          onResume={wizard.resume}
          onCancel={wizard.cancel}
          onRetry={wizard.retry}
        />
      )}

      {wizard.step === 'done' && job && (
        <DoneStep serverId={serverId} job={job} onStartOver={wizard.startOver} />
      )}

      <ImportedPeople serverId={serverId} />
    </div>
  );
});

export { Import };
