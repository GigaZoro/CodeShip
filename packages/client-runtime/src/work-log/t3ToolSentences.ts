import { msg, type Message } from "@t3tools/shared/i18n";

type Status = "inProgress" | "completed" | "failed" | "declined" | "stopped" | "other";

interface T3ToolSentence {
  readonly detail: Readonly<Record<Status, Message>>;
  readonly changeRequest?: Readonly<Record<Status, Message>>;
}

export function t3ToolSentence(labels: ReadonlyArray<string>): T3ToolSentence | undefined {
  return T3_TOOL_SENTENCES.get(labels.join("\n"));
}

// Whole sentences keep status-dependent grammar and change request identifiers together.
const T3_TOOL_SENTENCES: ReadonlyMap<string, T3ToolSentence> = new Map([
  [
    "Link\nLinking\nLinked\na pull request",
    {
      detail: {
        inProgress: msg("Linking a pull request"),
        completed: msg("Linked a pull request"),
        failed: msg("Failed to link a pull request"),
        declined: msg("Declined to link a pull request"),
        stopped: msg("Stopped linking a pull request"),
        other: msg("Linking a pull request"),
      },
      changeRequest: {
        inProgress: msg("Linking {changeRequest} #{number}"),
        completed: msg("Linked {changeRequest} #{number}"),
        failed: msg("Failed to link {changeRequest} #{number}"),
        declined: msg("Declined to link {changeRequest} #{number}"),
        stopped: msg("Stopped linking {changeRequest} #{number}"),
        other: msg("Linking {changeRequest} #{number}"),
      },
    },
  ],
  [
    "Link\nLinking\nLinked\npull requests",
    {
      detail: {
        inProgress: msg("Linking pull requests"),
        completed: msg("Linked pull requests"),
        failed: msg("Failed to link pull requests"),
        declined: msg("Declined to link pull requests"),
        stopped: msg("Stopped linking pull requests"),
        other: msg("Linking pull requests"),
      },
      changeRequest: {
        inProgress: msg("Linking {changeRequest} #{number}"),
        completed: msg("Linked {changeRequest} #{number}"),
        failed: msg("Failed to link {changeRequest} #{number}"),
        declined: msg("Declined to link {changeRequest} #{number}"),
        stopped: msg("Stopped linking {changeRequest} #{number}"),
        other: msg("Linking {changeRequest} #{number}"),
      },
    },
  ],
  [
    "Unlink\nUnlinking\nUnlinked\na pull request",
    {
      detail: {
        inProgress: msg("Unlinking a pull request"),
        completed: msg("Unlinked a pull request"),
        failed: msg("Failed to unlink a pull request"),
        declined: msg("Declined to unlink a pull request"),
        stopped: msg("Stopped unlinking a pull request"),
        other: msg("Unlinking a pull request"),
      },
      changeRequest: {
        inProgress: msg("Unlinking {changeRequest} #{number}"),
        completed: msg("Unlinked {changeRequest} #{number}"),
        failed: msg("Failed to unlink {changeRequest} #{number}"),
        declined: msg("Declined to unlink {changeRequest} #{number}"),
        stopped: msg("Stopped unlinking {changeRequest} #{number}"),
        other: msg("Unlinking {changeRequest} #{number}"),
      },
    },
  ],
  [
    "Unlink\nUnlinking\nUnlinked\npull requests by state",
    {
      detail: {
        inProgress: msg("Unlinking pull requests by state"),
        completed: msg("Unlinked pull requests by state"),
        failed: msg("Failed to unlink pull requests by state"),
        declined: msg("Declined to unlink pull requests by state"),
        stopped: msg("Stopped unlinking pull requests by state"),
        other: msg("Unlinking pull requests by state"),
      },
      changeRequest: {
        inProgress: msg("Unlinking {changeRequest} #{number}"),
        completed: msg("Unlinked {changeRequest} #{number}"),
        failed: msg("Failed to unlink {changeRequest} #{number}"),
        declined: msg("Declined to unlink {changeRequest} #{number}"),
        stopped: msg("Stopped unlinking {changeRequest} #{number}"),
        other: msg("Unlinking {changeRequest} #{number}"),
      },
    },
  ],
  [
    "Check\nChecking\nChecked\nlinked pull requests",
    {
      detail: {
        inProgress: msg("Checking linked pull requests"),
        completed: msg("Checked linked pull requests"),
        failed: msg("Failed to check linked pull requests"),
        declined: msg("Declined to check linked pull requests"),
        stopped: msg("Stopped checking linked pull requests"),
        other: msg("Checking linked pull requests"),
      },
    },
  ],
  [
    "Watch\nWatching\nWatching\na pull request",
    {
      detail: {
        inProgress: msg("Watching a pull request"),
        completed: msg("Watching a pull request"),
        failed: msg("Failed to watch a pull request"),
        declined: msg("Declined to watch a pull request"),
        stopped: msg("Stopped watching a pull request"),
        other: msg("Watching a pull request"),
      },
      changeRequest: {
        inProgress: msg("Watching {changeRequest} #{number}"),
        completed: msg("Watching {changeRequest} #{number}"),
        failed: msg("Failed to watch {changeRequest} #{number}"),
        declined: msg("Declined to watch {changeRequest} #{number}"),
        stopped: msg("Stopped watching {changeRequest} #{number}"),
        other: msg("Watching {changeRequest} #{number}"),
      },
    },
  ],
  [
    "Stop watching\nUnwatching\nStopped watching\na pull request",
    {
      detail: {
        inProgress: msg("Unwatching a pull request"),
        completed: msg("Stopped watching a pull request"),
        failed: msg("Failed to stop watching a pull request"),
        declined: msg("Declined to stop watching a pull request"),
        stopped: msg("Stopped unwatching a pull request"),
        other: msg("Unwatching a pull request"),
      },
      changeRequest: {
        inProgress: msg("Unwatching {changeRequest} #{number}"),
        completed: msg("Stopped watching {changeRequest} #{number}"),
        failed: msg("Failed to stop watching {changeRequest} #{number}"),
        declined: msg("Declined to stop watching {changeRequest} #{number}"),
        stopped: msg("Stopped unwatching {changeRequest} #{number}"),
        other: msg("Unwatching {changeRequest} #{number}"),
      },
    },
  ],
  [
    "Write\nWriting\nStarted writing\nreview guides",
    {
      detail: {
        inProgress: msg("Writing review guides"),
        completed: msg("Started writing review guides"),
        failed: msg("Failed to write review guides"),
        declined: msg("Declined to write review guides"),
        stopped: msg("Stopped writing review guides"),
        other: msg("Writing review guides"),
      },
    },
  ],
  [
    "Read\nReading\nRead\na review guide",
    {
      detail: {
        inProgress: msg("Reading a review guide"),
        completed: msg("Read a review guide"),
        failed: msg("Failed to read a review guide"),
        declined: msg("Declined to read a review guide"),
        stopped: msg("Stopped reading a review guide"),
        other: msg("Reading a review guide"),
      },
    },
  ],
  [
    "List\nListing\nListed\nissues",
    {
      detail: {
        inProgress: msg("Listing issues"),
        completed: msg("Listed issues"),
        failed: msg("Failed to list issues"),
        declined: msg("Declined to list issues"),
        stopped: msg("Stopped listing issues"),
        other: msg("Listing issues"),
      },
    },
  ],
  [
    "Read\nReading\nRead\nan issue",
    {
      detail: {
        inProgress: msg("Reading an issue"),
        completed: msg("Read an issue"),
        failed: msg("Failed to read an issue"),
        declined: msg("Declined to read an issue"),
        stopped: msg("Stopped reading an issue"),
        other: msg("Reading an issue"),
      },
    },
  ],
  [
    "File\nFiling\nFiled\nan issue",
    {
      detail: {
        inProgress: msg("Filing an issue"),
        completed: msg("Filed an issue"),
        failed: msg("Failed to file an issue"),
        declined: msg("Declined to file an issue"),
        stopped: msg("Stopped filing an issue"),
        other: msg("Filing an issue"),
      },
    },
  ],
  [
    "Comment on\nCommenting on\nCommented on\nan issue",
    {
      detail: {
        inProgress: msg("Commenting on an issue"),
        completed: msg("Commented on an issue"),
        failed: msg("Failed to comment on an issue"),
        declined: msg("Declined to comment on an issue"),
        stopped: msg("Stopped commenting on an issue"),
        other: msg("Commenting on an issue"),
      },
    },
  ],
  [
    "Change\nChanging\nChanged\nan issue's state",
    {
      detail: {
        inProgress: msg("Changing an issue's state"),
        completed: msg("Changed an issue's state"),
        failed: msg("Failed to change an issue's state"),
        declined: msg("Declined to change an issue's state"),
        stopped: msg("Stopped changing an issue's state"),
        other: msg("Changing an issue's state"),
      },
    },
  ],
  [
    "Link\nLinking\nLinked\nan issue",
    {
      detail: {
        inProgress: msg("Linking an issue"),
        completed: msg("Linked an issue"),
        failed: msg("Failed to link an issue"),
        declined: msg("Declined to link an issue"),
        stopped: msg("Stopped linking an issue"),
        other: msg("Linking an issue"),
      },
    },
  ],
  [
    "Unlink\nUnlinking\nUnlinked\nan issue",
    {
      detail: {
        inProgress: msg("Unlinking an issue"),
        completed: msg("Unlinked an issue"),
        failed: msg("Failed to unlink an issue"),
        declined: msg("Declined to unlink an issue"),
        stopped: msg("Stopped unlinking an issue"),
        other: msg("Unlinking an issue"),
      },
    },
  ],
  [
    "Check\nChecking\nChecked\nlinked issues",
    {
      detail: {
        inProgress: msg("Checking linked issues"),
        completed: msg("Checked linked issues"),
        failed: msg("Failed to check linked issues"),
        declined: msg("Declined to check linked issues"),
        stopped: msg("Stopped checking linked issues"),
        other: msg("Checking linked issues"),
      },
    },
  ],
  [
    "Get\nGetting\nGot\norchestration capabilities",
    {
      detail: {
        inProgress: msg("Getting orchestration capabilities"),
        completed: msg("Got orchestration capabilities"),
        failed: msg("Failed to get orchestration capabilities"),
        declined: msg("Declined to get orchestration capabilities"),
        stopped: msg("Stopped getting orchestration capabilities"),
        other: msg("Getting orchestration capabilities"),
      },
    },
  ],
  [
    "Delegate\nDelegating\nDelegated\na child task",
    {
      detail: {
        inProgress: msg("Delegating a child task"),
        completed: msg("Delegated a child task"),
        failed: msg("Failed to delegate a child task"),
        declined: msg("Declined to delegate a child task"),
        stopped: msg("Stopped delegating a child task"),
        other: msg("Delegating a child task"),
      },
    },
  ],
  [
    "Get\nGetting\nGot\ndelegated task status",
    {
      detail: {
        inProgress: msg("Getting delegated task status"),
        completed: msg("Got delegated task status"),
        failed: msg("Failed to get delegated task status"),
        declined: msg("Declined to get delegated task status"),
        stopped: msg("Stopped getting delegated task status"),
        other: msg("Getting delegated task status"),
      },
    },
  ],
  [
    "Cancel\nCanceling\nRequested cancellation of\na delegated task",
    {
      detail: {
        inProgress: msg("Canceling a delegated task"),
        completed: msg("Requested cancellation of a delegated task"),
        failed: msg("Failed to cancel a delegated task"),
        declined: msg("Declined to cancel a delegated task"),
        stopped: msg("Stopped canceling a delegated task"),
        other: msg("Canceling a delegated task"),
      },
    },
  ],
  [
    "Schedule\nScheduling\nScheduled\na task",
    {
      detail: {
        inProgress: msg("Scheduling a task"),
        completed: msg("Scheduled a task"),
        failed: msg("Failed to schedule a task"),
        declined: msg("Declined to schedule a task"),
        stopped: msg("Stopped scheduling a task"),
        other: msg("Scheduling a task"),
      },
    },
  ],
  [
    "List\nListing\nListed\nscheduled tasks",
    {
      detail: {
        inProgress: msg("Listing scheduled tasks"),
        completed: msg("Listed scheduled tasks"),
        failed: msg("Failed to list scheduled tasks"),
        declined: msg("Declined to list scheduled tasks"),
        stopped: msg("Stopped listing scheduled tasks"),
        other: msg("Listing scheduled tasks"),
      },
    },
  ],
  [
    "Update\nUpdating\nUpdated\na scheduled task",
    {
      detail: {
        inProgress: msg("Updating a scheduled task"),
        completed: msg("Updated a scheduled task"),
        failed: msg("Failed to update a scheduled task"),
        declined: msg("Declined to update a scheduled task"),
        stopped: msg("Stopped updating a scheduled task"),
        other: msg("Updating a scheduled task"),
      },
    },
  ],
  [
    "Delete\nDeleting\nRequested deletion of\na scheduled task",
    {
      detail: {
        inProgress: msg("Deleting a scheduled task"),
        completed: msg("Requested deletion of a scheduled task"),
        failed: msg("Failed to delete a scheduled task"),
        declined: msg("Declined to delete a scheduled task"),
        stopped: msg("Stopped deleting a scheduled task"),
        other: msg("Deleting a scheduled task"),
      },
    },
  ],
  [
    "Ask for\nAsking for\nAsked for\na secret",
    {
      detail: {
        inProgress: msg("Asking for a secret"),
        completed: msg("Asked for a secret"),
        failed: msg("Failed to ask for a secret"),
        declined: msg("Declined to ask for a secret"),
        stopped: msg("Stopped asking for a secret"),
        other: msg("Asking for a secret"),
      },
    },
  ],
  [
    "Create\nCreating\nCreated\nT3.CodeShip threads",
    {
      detail: {
        inProgress: msg("Creating T3.CodeShip threads"),
        completed: msg("Created T3.CodeShip threads"),
        failed: msg("Failed to create T3.CodeShip threads"),
        declined: msg("Declined to create T3.CodeShip threads"),
        stopped: msg("Stopped creating T3.CodeShip threads"),
        other: msg("Creating T3.CodeShip threads"),
      },
    },
  ],
  [
    "Start\nStarting\nStarted\na T3.CodeShip thread",
    {
      detail: {
        inProgress: msg("Starting a T3.CodeShip thread"),
        completed: msg("Started a T3.CodeShip thread"),
        failed: msg("Failed to start a T3.CodeShip thread"),
        declined: msg("Declined to start a T3.CodeShip thread"),
        stopped: msg("Stopped starting a T3.CodeShip thread"),
        other: msg("Starting a T3.CodeShip thread"),
      },
    },
  ],
  [
    "List\nListing\nListed\nT3.CodeShip threads",
    {
      detail: {
        inProgress: msg("Listing T3.CodeShip threads"),
        completed: msg("Listed T3.CodeShip threads"),
        failed: msg("Failed to list T3.CodeShip threads"),
        declined: msg("Declined to list T3.CodeShip threads"),
        stopped: msg("Stopped listing T3.CodeShip threads"),
        other: msg("Listing T3.CodeShip threads"),
      },
    },
  ],
  [
    "Read\nReading\nRead\na T3.CodeShip thread",
    {
      detail: {
        inProgress: msg("Reading a T3.CodeShip thread"),
        completed: msg("Read a T3.CodeShip thread"),
        failed: msg("Failed to read a T3.CodeShip thread"),
        declined: msg("Declined to read a T3.CodeShip thread"),
        stopped: msg("Stopped reading a T3.CodeShip thread"),
        other: msg("Reading a T3.CodeShip thread"),
      },
    },
  ],
  [
    "Send\nSending\nSent\nto a T3.CodeShip thread",
    {
      detail: {
        inProgress: msg("Sending to a T3.CodeShip thread"),
        completed: msg("Sent to a T3.CodeShip thread"),
        failed: msg("Failed to send to a T3.CodeShip thread"),
        declined: msg("Declined to send to a T3.CodeShip thread"),
        stopped: msg("Stopped sending to a T3.CodeShip thread"),
        other: msg("Sending to a T3.CodeShip thread"),
      },
    },
  ],
  [
    "Wait\nWaiting\nWaited\nfor a T3.CodeShip thread",
    {
      detail: {
        inProgress: msg("Waiting for a T3.CodeShip thread"),
        completed: msg("Waited for a T3.CodeShip thread"),
        failed: msg("Failed to wait for a T3.CodeShip thread"),
        declined: msg("Declined to wait for a T3.CodeShip thread"),
        stopped: msg("Stopped waiting for a T3.CodeShip thread"),
        other: msg("Waiting for a T3.CodeShip thread"),
      },
    },
  ],
  [
    "Stop\nStopping\nRequested a stop for\na workflow",
    {
      detail: {
        inProgress: msg("Stopping a workflow"),
        completed: msg("Requested a stop for a workflow"),
        failed: msg("Failed to stop a workflow"),
        declined: msg("Declined to stop a workflow"),
        stopped: msg("Stopped stopping a workflow"),
        other: msg("Stopping a workflow"),
      },
    },
  ],
  [
    "Update\nUpdating\nUpdated\nbackground waits",
    {
      detail: {
        inProgress: msg("Updating background waits"),
        completed: msg("Updated background waits"),
        failed: msg("Failed to update background waits"),
        declined: msg("Declined to update background waits"),
        stopped: msg("Stopped updating background waits"),
        other: msg("Updating background waits"),
      },
    },
  ],
  [
    "Interrupt\nInterrupting\nRequested an interrupt of\na T3.CodeShip thread",
    {
      detail: {
        inProgress: msg("Interrupting a T3.CodeShip thread"),
        completed: msg("Requested an interrupt of a T3.CodeShip thread"),
        failed: msg("Failed to interrupt a T3.CodeShip thread"),
        declined: msg("Declined to interrupt a T3.CodeShip thread"),
        stopped: msg("Stopped interrupting a T3.CodeShip thread"),
        other: msg("Interrupting a T3.CodeShip thread"),
      },
    },
  ],
  [
    "Hand off\nHanding off\nHanded off\nthread to a git worktree",
    {
      detail: {
        inProgress: msg("Handing off thread to a git worktree"),
        completed: msg("Handed off thread to a git worktree"),
        failed: msg("Failed to hand off thread to a git worktree"),
        declined: msg("Declined to hand off thread to a git worktree"),
        stopped: msg("Stopped handing off thread to a git worktree"),
        other: msg("Handing off thread to a git worktree"),
      },
    },
  ],
  [
    "Get\nGetting\nGot\nthread worktree status",
    {
      detail: {
        inProgress: msg("Getting thread worktree status"),
        completed: msg("Got thread worktree status"),
        failed: msg("Failed to get thread worktree status"),
        declined: msg("Declined to get thread worktree status"),
        stopped: msg("Stopped getting thread worktree status"),
        other: msg("Getting thread worktree status"),
      },
    },
  ],
  [
    "Get\nGetting\nGot\npreview browser status",
    {
      detail: {
        inProgress: msg("Getting preview browser status"),
        completed: msg("Got preview browser status"),
        failed: msg("Failed to get preview browser status"),
        declined: msg("Declined to get preview browser status"),
        stopped: msg("Stopped getting preview browser status"),
        other: msg("Getting preview browser status"),
      },
    },
  ],
  [
    "Open\nOpening\nOpened\na page in the preview browser",
    {
      detail: {
        inProgress: msg("Opening a page in the preview browser"),
        completed: msg("Opened a page in the preview browser"),
        failed: msg("Failed to open a page in the preview browser"),
        declined: msg("Declined to open a page in the preview browser"),
        stopped: msg("Stopped opening a page in the preview browser"),
        other: msg("Opening a page in the preview browser"),
      },
    },
  ],
  [
    "Navigate\nNavigating\nNavigated\nthe preview browser",
    {
      detail: {
        inProgress: msg("Navigating the preview browser"),
        completed: msg("Navigated the preview browser"),
        failed: msg("Failed to navigate the preview browser"),
        declined: msg("Declined to navigate the preview browser"),
        stopped: msg("Stopped navigating the preview browser"),
        other: msg("Navigating the preview browser"),
      },
    },
  ],
  [
    "Respond\nResponding\nResponded\nto a preview browser dialog",
    {
      detail: {
        inProgress: msg("Responding to a preview browser dialog"),
        completed: msg("Responded to a preview browser dialog"),
        failed: msg("Failed to respond to a preview browser dialog"),
        declined: msg("Declined to respond to a preview browser dialog"),
        stopped: msg("Stopped responding to a preview browser dialog"),
        other: msg("Responding to a preview browser dialog"),
      },
    },
  ],
  [
    "Take a snapshot of\nTaking a snapshot of\nTook a snapshot of\nthe preview page",
    {
      detail: {
        inProgress: msg("Taking a snapshot of the preview page"),
        completed: msg("Took a snapshot of the preview page"),
        failed: msg("Failed to take a snapshot of the preview page"),
        declined: msg("Declined to take a snapshot of the preview page"),
        stopped: msg("Stopped taking a snapshot of the preview page"),
        other: msg("Taking a snapshot of the preview page"),
      },
    },
  ],
  [
    "Use\nUsing\nUsed\nthe preview browser",
    {
      detail: {
        inProgress: msg("Using the preview browser"),
        completed: msg("Used the preview browser"),
        failed: msg("Failed to use the preview browser"),
        declined: msg("Declined to use the preview browser"),
        stopped: msg("Stopped using the preview browser"),
        other: msg("Using the preview browser"),
      },
    },
  ],
  [
    "Click\nClicking\nClicked\nin the preview browser",
    {
      detail: {
        inProgress: msg("Clicking in the preview browser"),
        completed: msg("Clicked in the preview browser"),
        failed: msg("Failed to click in the preview browser"),
        declined: msg("Declined to click in the preview browser"),
        stopped: msg("Stopped clicking in the preview browser"),
        other: msg("Clicking in the preview browser"),
      },
    },
  ],
  [
    "Press\nPressing\nPressed\na key in the preview browser",
    {
      detail: {
        inProgress: msg("Pressing a key in the preview browser"),
        completed: msg("Pressed a key in the preview browser"),
        failed: msg("Failed to press a key in the preview browser"),
        declined: msg("Declined to press a key in the preview browser"),
        stopped: msg("Stopped pressing a key in the preview browser"),
        other: msg("Pressing a key in the preview browser"),
      },
    },
  ],
  [
    "Type\nTyping\nTyped\nin the preview browser",
    {
      detail: {
        inProgress: msg("Typing in the preview browser"),
        completed: msg("Typed in the preview browser"),
        failed: msg("Failed to type in the preview browser"),
        declined: msg("Declined to type in the preview browser"),
        stopped: msg("Stopped typing in the preview browser"),
        other: msg("Typing in the preview browser"),
      },
    },
  ],
  [
    "Hover\nHovering\nHovered\nin the preview browser",
    {
      detail: {
        inProgress: msg("Hovering in the preview browser"),
        completed: msg("Hovered in the preview browser"),
        failed: msg("Failed to hover in the preview browser"),
        declined: msg("Declined to hover in the preview browser"),
        stopped: msg("Stopped hovering in the preview browser"),
        other: msg("Hovering in the preview browser"),
      },
    },
  ],
  [
    "Choose\nChoosing\nChose\nan option in the preview browser",
    {
      detail: {
        inProgress: msg("Choosing an option in the preview browser"),
        completed: msg("Chose an option in the preview browser"),
        failed: msg("Failed to choose an option in the preview browser"),
        declined: msg("Declined to choose an option in the preview browser"),
        stopped: msg("Stopped choosing an option in the preview browser"),
        other: msg("Choosing an option in the preview browser"),
      },
    },
  ],
  [
    "Drag\nDragging\nDragged\nin the preview browser",
    {
      detail: {
        inProgress: msg("Dragging in the preview browser"),
        completed: msg("Dragged in the preview browser"),
        failed: msg("Failed to drag in the preview browser"),
        declined: msg("Declined to drag in the preview browser"),
        stopped: msg("Stopped dragging in the preview browser"),
        other: msg("Dragging in the preview browser"),
      },
    },
  ],
  [
    "Upload\nUploading\nUploaded\nfiles to the preview browser",
    {
      detail: {
        inProgress: msg("Uploading files to the preview browser"),
        completed: msg("Uploaded files to the preview browser"),
        failed: msg("Failed to upload files to the preview browser"),
        declined: msg("Declined to upload files to the preview browser"),
        stopped: msg("Stopped uploading files to the preview browser"),
        other: msg("Uploading files to the preview browser"),
      },
    },
  ],
  [
    "Scroll\nScrolling\nScrolled\nthe preview browser",
    {
      detail: {
        inProgress: msg("Scrolling the preview browser"),
        completed: msg("Scrolled the preview browser"),
        failed: msg("Failed to scroll the preview browser"),
        declined: msg("Declined to scroll the preview browser"),
        stopped: msg("Stopped scrolling the preview browser"),
        other: msg("Scrolling the preview browser"),
      },
    },
  ],
  [
    "Resize\nResizing\nResized\nthe preview browser",
    {
      detail: {
        inProgress: msg("Resizing the preview browser"),
        completed: msg("Resized the preview browser"),
        failed: msg("Failed to resize the preview browser"),
        declined: msg("Declined to resize the preview browser"),
        stopped: msg("Stopped resizing the preview browser"),
        other: msg("Resizing the preview browser"),
      },
    },
  ],
  [
    "Evaluate\nEvaluating\nEvaluated\nscript in the preview browser",
    {
      detail: {
        inProgress: msg("Evaluating script in the preview browser"),
        completed: msg("Evaluated script in the preview browser"),
        failed: msg("Failed to evaluate script in the preview browser"),
        declined: msg("Declined to evaluate script in the preview browser"),
        stopped: msg("Stopped evaluating script in the preview browser"),
        other: msg("Evaluating script in the preview browser"),
      },
    },
  ],
  [
    "Wait\nWaiting\nWaited\nfor the preview page",
    {
      detail: {
        inProgress: msg("Waiting for the preview page"),
        completed: msg("Waited for the preview page"),
        failed: msg("Failed to wait for the preview page"),
        declined: msg("Declined to wait for the preview page"),
        stopped: msg("Stopped waiting for the preview page"),
        other: msg("Waiting for the preview page"),
      },
    },
  ],
  [
    "Set\nSetting\nSet\npreview browser appearance",
    {
      detail: {
        inProgress: msg("Setting preview browser appearance"),
        completed: msg("Set preview browser appearance"),
        failed: msg("Failed to set preview browser appearance"),
        declined: msg("Declined to set preview browser appearance"),
        stopped: msg("Stopped setting preview browser appearance"),
        other: msg("Setting preview browser appearance"),
      },
    },
  ],
  [
    "Start\nStarting\nStarted\nrecording the preview browser",
    {
      detail: {
        inProgress: msg("Starting recording the preview browser"),
        completed: msg("Started recording the preview browser"),
        failed: msg("Failed to start recording the preview browser"),
        declined: msg("Declined to start recording the preview browser"),
        stopped: msg("Stopped starting recording the preview browser"),
        other: msg("Starting recording the preview browser"),
      },
    },
  ],
  [
    "Stop\nStopping\nStopped\nrecording the preview browser",
    {
      detail: {
        inProgress: msg("Stopping recording the preview browser"),
        completed: msg("Stopped recording the preview browser"),
        failed: msg("Failed to stop recording the preview browser"),
        declined: msg("Declined to stop recording the preview browser"),
        stopped: msg("Stopped stopping recording the preview browser"),
        other: msg("Stopping recording the preview browser"),
      },
    },
  ],
  [
    "List\nListing\nListed\nsimulators and emulators",
    {
      detail: {
        inProgress: msg("Listing simulators and emulators"),
        completed: msg("Listed simulators and emulators"),
        failed: msg("Failed to list simulators and emulators"),
        declined: msg("Declined to list simulators and emulators"),
        stopped: msg("Stopped listing simulators and emulators"),
        other: msg("Listing simulators and emulators"),
      },
    },
  ],
  [
    "Open\nOpening\nOpened\na device in the Device panel",
    {
      detail: {
        inProgress: msg("Opening a device in the Device panel"),
        completed: msg("Opened a device in the Device panel"),
        failed: msg("Failed to open a device in the Device panel"),
        declined: msg("Declined to open a device in the Device panel"),
        stopped: msg("Stopped opening a device in the Device panel"),
        other: msg("Opening a device in the Device panel"),
      },
    },
  ],
  [
    "Take a screenshot of\nTaking a screenshot of\nTook a screenshot of\nthe device",
    {
      detail: {
        inProgress: msg("Taking a screenshot of the device"),
        completed: msg("Took a screenshot of the device"),
        failed: msg("Failed to take a screenshot of the device"),
        declined: msg("Declined to take a screenshot of the device"),
        stopped: msg("Stopped taking a screenshot of the device"),
        other: msg("Taking a screenshot of the device"),
      },
    },
  ],
  [
    "Close\nClosing\nClosed\na device",
    {
      detail: {
        inProgress: msg("Closing a device"),
        completed: msg("Closed a device"),
        failed: msg("Failed to close a device"),
        declined: msg("Declined to close a device"),
        stopped: msg("Stopped closing a device"),
        other: msg("Closing a device"),
      },
    },
  ],
  [
    "Run\nRunning\nRequested a run of\na scheduled task",
    {
      detail: {
        inProgress: msg("Running a scheduled task"),
        completed: msg("Requested a run of a scheduled task"),
        failed: msg("Failed to run a scheduled task"),
        declined: msg("Declined to run a scheduled task"),
        stopped: msg("Stopped running a scheduled task"),
        other: msg("Running a scheduled task"),
      },
    },
  ],
  [
    "Manage\nManaging\nManaged\nqueued messages",
    {
      detail: {
        inProgress: msg("Managing queued messages"),
        completed: msg("Managed queued messages"),
        failed: msg("Failed to manage queued messages"),
        declined: msg("Declined to manage queued messages"),
        stopped: msg("Stopped managing queued messages"),
        other: msg("Managing queued messages"),
      },
    },
  ],
  [
    "Handle\nHandling\nHandled\npending questions",
    {
      detail: {
        inProgress: msg("Handling pending questions"),
        completed: msg("Handled pending questions"),
        failed: msg("Failed to handle pending questions"),
        declined: msg("Declined to handle pending questions"),
        stopped: msg("Stopped handling pending questions"),
        other: msg("Handling pending questions"),
      },
    },
  ],
  [
    "List\nListing\nListed\nqueued messages",
    {
      detail: {
        inProgress: msg("Listing queued messages"),
        completed: msg("Listed queued messages"),
        failed: msg("Failed to list queued messages"),
        declined: msg("Declined to list queued messages"),
        stopped: msg("Stopped listing queued messages"),
        other: msg("Listing queued messages"),
      },
    },
  ],
  [
    "Read\nReading\nRead\na queued message",
    {
      detail: {
        inProgress: msg("Reading a queued message"),
        completed: msg("Read a queued message"),
        failed: msg("Failed to read a queued message"),
        declined: msg("Declined to read a queued message"),
        stopped: msg("Stopped reading a queued message"),
        other: msg("Reading a queued message"),
      },
    },
  ],
  [
    "Edit\nEditing\nEdited\na queued message",
    {
      detail: {
        inProgress: msg("Editing a queued message"),
        completed: msg("Edited a queued message"),
        failed: msg("Failed to edit a queued message"),
        declined: msg("Declined to edit a queued message"),
        stopped: msg("Stopped editing a queued message"),
        other: msg("Editing a queued message"),
      },
    },
  ],
  [
    "Cancel\nCanceling\nRequested cancellation of\na queued run",
    {
      detail: {
        inProgress: msg("Canceling a queued run"),
        completed: msg("Requested cancellation of a queued run"),
        failed: msg("Failed to cancel a queued run"),
        declined: msg("Declined to cancel a queued run"),
        stopped: msg("Stopped canceling a queued run"),
        other: msg("Canceling a queued run"),
      },
    },
  ],
  [
    "Reorder\nReordering\nReordered\na queued run",
    {
      detail: {
        inProgress: msg("Reordering a queued run"),
        completed: msg("Reordered a queued run"),
        failed: msg("Failed to reorder a queued run"),
        declined: msg("Declined to reorder a queued run"),
        stopped: msg("Stopped reordering a queued run"),
        other: msg("Reordering a queued run"),
      },
    },
  ],
  [
    "Steer with\nSteering with\nRequested steering with\na queued message",
    {
      detail: {
        inProgress: msg("Steering with a queued message"),
        completed: msg("Requested steering with a queued message"),
        failed: msg("Failed to steer with a queued message"),
        declined: msg("Declined to steer with a queued message"),
        stopped: msg("Stopped steering with a queued message"),
        other: msg("Steering with a queued message"),
      },
    },
  ],
  [
    "List\nListing\nListed\npending questions",
    {
      detail: {
        inProgress: msg("Listing pending questions"),
        completed: msg("Listed pending questions"),
        failed: msg("Failed to list pending questions"),
        declined: msg("Declined to list pending questions"),
        stopped: msg("Stopped listing pending questions"),
        other: msg("Listing pending questions"),
      },
    },
  ],
  [
    "Read\nReading\nRead\npending questions",
    {
      detail: {
        inProgress: msg("Reading pending questions"),
        completed: msg("Read pending questions"),
        failed: msg("Failed to read pending questions"),
        declined: msg("Declined to read pending questions"),
        stopped: msg("Stopped reading pending questions"),
        other: msg("Reading pending questions"),
      },
    },
  ],
  [
    "Answer\nAnswering\nAnswered\npending questions",
    {
      detail: {
        inProgress: msg("Answering pending questions"),
        completed: msg("Answered pending questions"),
        failed: msg("Failed to answer pending questions"),
        declined: msg("Declined to answer pending questions"),
        stopped: msg("Stopped answering pending questions"),
        other: msg("Answering pending questions"),
      },
    },
  ],
  [
    "Read\nReading\nRead\nthread configuration",
    {
      detail: {
        inProgress: msg("Reading thread configuration"),
        completed: msg("Read thread configuration"),
        failed: msg("Failed to read thread configuration"),
        declined: msg("Declined to read thread configuration"),
        stopped: msg("Stopped reading thread configuration"),
        other: msg("Reading thread configuration"),
      },
    },
  ],
  [
    "Use\nUsing\nUsed\nthread model settings",
    {
      detail: {
        inProgress: msg("Using thread model settings"),
        completed: msg("Used thread model settings"),
        failed: msg("Failed to use thread model settings"),
        declined: msg("Declined to use thread model settings"),
        stopped: msg("Stopped using thread model settings"),
        other: msg("Using thread model settings"),
      },
    },
  ],
  [
    "Use\nUsing\nUsed\nthread transfers",
    {
      detail: {
        inProgress: msg("Using thread transfers"),
        completed: msg("Used thread transfers"),
        failed: msg("Failed to use thread transfers"),
        declined: msg("Declined to use thread transfers"),
        stopped: msg("Stopped using thread transfers"),
        other: msg("Using thread transfers"),
      },
    },
  ],
  [
    "Fork\nForking\nRequested a fork of\nthis thread",
    {
      detail: {
        inProgress: msg("Forking this thread"),
        completed: msg("Requested a fork of this thread"),
        failed: msg("Failed to fork this thread"),
        declined: msg("Declined to fork this thread"),
        stopped: msg("Stopped forking this thread"),
        other: msg("Forking this thread"),
      },
    },
  ],
  [
    "Merge\nMerging\nRequested a merge of\nthread context",
    {
      detail: {
        inProgress: msg("Merging thread context"),
        completed: msg("Requested a merge of thread context"),
        failed: msg("Failed to merge thread context"),
        declined: msg("Declined to merge thread context"),
        stopped: msg("Stopped merging thread context"),
        other: msg("Merging thread context"),
      },
    },
  ],
  [
    "Search\nSearching\nSearched\nthread content",
    {
      detail: {
        inProgress: msg("Searching thread content"),
        completed: msg("Searched thread content"),
        failed: msg("Failed to search thread content"),
        declined: msg("Declined to search thread content"),
        stopped: msg("Stopped searching thread content"),
        other: msg("Searching thread content"),
      },
    },
  ],
  [
    "Read\nReading\nRead\nthread transfers",
    {
      detail: {
        inProgress: msg("Reading thread transfers"),
        completed: msg("Read thread transfers"),
        failed: msg("Failed to read thread transfers"),
        declined: msg("Declined to read thread transfers"),
        stopped: msg("Stopped reading thread transfers"),
        other: msg("Reading thread transfers"),
      },
    },
  ],
  [
    "Organize\nOrganizing\nOrganized\na thread",
    {
      detail: {
        inProgress: msg("Organizing a thread"),
        completed: msg("Organized a thread"),
        failed: msg("Failed to organize a thread"),
        declined: msg("Declined to organize a thread"),
        stopped: msg("Stopped organizing a thread"),
        other: msg("Organizing a thread"),
      },
    },
  ],
  [
    "Update\nUpdating\nUpdated\nT3.CodeShip thread metadata",
    {
      detail: {
        inProgress: msg("Updating T3.CodeShip thread metadata"),
        completed: msg("Updated T3.CodeShip thread metadata"),
        failed: msg("Failed to update T3.CodeShip thread metadata"),
        declined: msg("Declined to update T3.CodeShip thread metadata"),
        stopped: msg("Stopped updating T3.CodeShip thread metadata"),
        other: msg("Updating T3.CodeShip thread metadata"),
      },
    },
  ],
  [
    "List\nListing\nListed\nworkspace branches",
    {
      detail: {
        inProgress: msg("Listing workspace branches"),
        completed: msg("Listed workspace branches"),
        failed: msg("Failed to list workspace branches"),
        declined: msg("Declined to list workspace branches"),
        stopped: msg("Stopped listing workspace branches"),
        other: msg("Listing workspace branches"),
      },
    },
  ],
  [
    "List\nListing\nListed\npreview tabs",
    {
      detail: {
        inProgress: msg("Listing preview tabs"),
        completed: msg("Listed preview tabs"),
        failed: msg("Failed to list preview tabs"),
        declined: msg("Declined to list preview tabs"),
        stopped: msg("Stopped listing preview tabs"),
        other: msg("Listing preview tabs"),
      },
    },
  ],
  [
    "Close\nClosing\nClosed\na preview tab",
    {
      detail: {
        inProgress: msg("Closing a preview tab"),
        completed: msg("Closed a preview tab"),
        failed: msg("Failed to close a preview tab"),
        declined: msg("Declined to close a preview tab"),
        stopped: msg("Stopped closing a preview tab"),
        other: msg("Closing a preview tab"),
      },
    },
  ],
  [
    "Read\nReading\nRead\nenvironment preferences",
    {
      detail: {
        inProgress: msg("Reading environment preferences"),
        completed: msg("Read environment preferences"),
        failed: msg("Failed to read environment preferences"),
        declined: msg("Declined to read environment preferences"),
        stopped: msg("Stopped reading environment preferences"),
        other: msg("Reading environment preferences"),
      },
    },
  ],
  [
    "List\nListing\nListed\nlinked environments",
    {
      detail: {
        inProgress: msg("Listing linked environments"),
        completed: msg("Listed linked environments"),
        failed: msg("Failed to list linked environments"),
        declined: msg("Declined to list linked environments"),
        stopped: msg("Stopped listing linked environments"),
        other: msg("Listing linked environments"),
      },
    },
  ],
  [
    "Ask to link\nAsking to link\nAsked to link\nan environment",
    {
      detail: {
        inProgress: msg("Asking to link an environment"),
        completed: msg("Asked to link an environment"),
        failed: msg("Failed to ask to link an environment"),
        declined: msg("Declined to ask to link an environment"),
        stopped: msg("Stopped asking to link an environment"),
        other: msg("Asking to link an environment"),
      },
    },
  ],
  [
    "Forget\nForgetting\nForgot\na linked environment",
    {
      detail: {
        inProgress: msg("Forgetting a linked environment"),
        completed: msg("Forgot a linked environment"),
        failed: msg("Failed to forget a linked environment"),
        declined: msg("Declined to forget a linked environment"),
        stopped: msg("Stopped forgetting a linked environment"),
        other: msg("Forgetting a linked environment"),
      },
    },
  ],
  [
    "Update\nUpdating\nUpdated\nenvironment preferences",
    {
      detail: {
        inProgress: msg("Updating environment preferences"),
        completed: msg("Updated environment preferences"),
        failed: msg("Failed to update environment preferences"),
        declined: msg("Declined to update environment preferences"),
        stopped: msg("Stopped updating environment preferences"),
        other: msg("Updating environment preferences"),
      },
    },
  ],
  [
    "Read\nReading\nRead\nthemes",
    {
      detail: {
        inProgress: msg("Reading themes"),
        completed: msg("Read themes"),
        failed: msg("Failed to read themes"),
        declined: msg("Declined to read themes"),
        stopped: msg("Stopped reading themes"),
        other: msg("Reading themes"),
      },
    },
  ],
  [
    "Set\nSetting\nSet\nthe theme",
    {
      detail: {
        inProgress: msg("Setting the theme"),
        completed: msg("Set the theme"),
        failed: msg("Failed to set the theme"),
        declined: msg("Declined to set the theme"),
        stopped: msg("Stopped setting the theme"),
        other: msg("Setting the theme"),
      },
    },
  ],
  [
    "Launch\nLaunching\nLaunched\na project thread",
    {
      detail: {
        inProgress: msg("Launching a project thread"),
        completed: msg("Launched a project thread"),
        failed: msg("Failed to launch a project thread"),
        declined: msg("Declined to launch a project thread"),
        stopped: msg("Stopped launching a project thread"),
        other: msg("Launching a project thread"),
      },
    },
  ],
  [
    "List\nListing\nListed\nprojects",
    {
      detail: {
        inProgress: msg("Listing projects"),
        completed: msg("Listed projects"),
        failed: msg("Failed to list projects"),
        declined: msg("Declined to list projects"),
        stopped: msg("Stopped listing projects"),
        other: msg("Listing projects"),
      },
    },
  ],
  [
    "Read\nReading\nRead\na project",
    {
      detail: {
        inProgress: msg("Reading a project"),
        completed: msg("Read a project"),
        failed: msg("Failed to read a project"),
        declined: msg("Declined to read a project"),
        stopped: msg("Stopped reading a project"),
        other: msg("Reading a project"),
      },
    },
  ],
  [
    "Register\nRegistering\nRegistered\na project",
    {
      detail: {
        inProgress: msg("Registering a project"),
        completed: msg("Registered a project"),
        failed: msg("Failed to register a project"),
        declined: msg("Declined to register a project"),
        stopped: msg("Stopped registering a project"),
        other: msg("Registering a project"),
      },
    },
  ],
  [
    "Update\nUpdating\nUpdated\na project",
    {
      detail: {
        inProgress: msg("Updating a project"),
        completed: msg("Updated a project"),
        failed: msg("Failed to update a project"),
        declined: msg("Declined to update a project"),
        stopped: msg("Stopped updating a project"),
        other: msg("Updating a project"),
      },
    },
  ],
  [
    "Delete\nDeleting\nDeleted\na project",
    {
      detail: {
        inProgress: msg("Deleting a project"),
        completed: msg("Deleted a project"),
        failed: msg("Failed to delete a project"),
        declined: msg("Declined to delete a project"),
        stopped: msg("Stopped deleting a project"),
        other: msg("Deleting a project"),
      },
    },
  ],
  [
    "Clone\nCloning\nCloned\na repository",
    {
      detail: {
        inProgress: msg("Cloning a repository"),
        completed: msg("Cloned a repository"),
        failed: msg("Failed to clone a repository"),
        declined: msg("Declined to clone a repository"),
        stopped: msg("Stopped cloning a repository"),
        other: msg("Cloning a repository"),
      },
    },
  ],
  [
    "Prepare\nPreparing\nPrepared\nan attachment upload",
    {
      detail: {
        inProgress: msg("Preparing an attachment upload"),
        completed: msg("Prepared an attachment upload"),
        failed: msg("Failed to prepare an attachment upload"),
        declined: msg("Declined to prepare an attachment upload"),
        stopped: msg("Stopped preparing an attachment upload"),
        other: msg("Preparing an attachment upload"),
      },
    },
  ],
  [
    "Discard\nDiscarding\nDiscarded\na pending attachment",
    {
      detail: {
        inProgress: msg("Discarding a pending attachment"),
        completed: msg("Discarded a pending attachment"),
        failed: msg("Failed to discard a pending attachment"),
        declined: msg("Declined to discard a pending attachment"),
        stopped: msg("Stopped discarding a pending attachment"),
        other: msg("Discarding a pending attachment"),
      },
    },
  ],
  [
    "Send\nSending\nSent\nattachments",
    {
      detail: {
        inProgress: msg("Sending attachments"),
        completed: msg("Sent attachments"),
        failed: msg("Failed to send attachments"),
        declined: msg("Declined to send attachments"),
        stopped: msg("Stopped sending attachments"),
        other: msg("Sending attachments"),
      },
    },
  ],
  [
    "Preview\nPreviewing\nPreviewed\nan HTML page",
    {
      detail: {
        inProgress: msg("Previewing an HTML page"),
        completed: msg("Previewed an HTML page"),
        failed: msg("Failed to preview an HTML page"),
        declined: msg("Declined to preview an HTML page"),
        stopped: msg("Stopped previewing an HTML page"),
        other: msg("Previewing an HTML page"),
      },
    },
  ],
  [
    "Render\nRendering\nRendered\nan HTML page",
    {
      detail: {
        inProgress: msg("Rendering an HTML page"),
        completed: msg("Rendered an HTML page"),
        failed: msg("Failed to render an HTML page"),
        declined: msg("Declined to render an HTML page"),
        stopped: msg("Stopped rendering an HTML page"),
        other: msg("Rendering an HTML page"),
      },
    },
  ],
  [
    "Send\nSending\nSent\na message",
    {
      detail: {
        inProgress: msg("Sending a message"),
        completed: msg("Sent a message"),
        failed: msg("Failed to send a message"),
        declined: msg("Declined to send a message"),
        stopped: msg("Stopped sending a message"),
        other: msg("Sending a message"),
      },
    },
  ],
  [
    "Read\nReading\nRead\na pull request",
    {
      detail: {
        inProgress: msg("Reading a pull request"),
        completed: msg("Read a pull request"),
        failed: msg("Failed to read a pull request"),
        declined: msg("Declined to read a pull request"),
        stopped: msg("Stopped reading a pull request"),
        other: msg("Reading a pull request"),
      },
    },
  ],
  [
    "List\nListing\nListed\npull requests",
    {
      detail: {
        inProgress: msg("Listing pull requests"),
        completed: msg("Listed pull requests"),
        failed: msg("Failed to list pull requests"),
        declined: msg("Declined to list pull requests"),
        stopped: msg("Stopped listing pull requests"),
        other: msg("Listing pull requests"),
      },
    },
  ],
  [
    "Open\nOpening\nOpened\na pull request",
    {
      detail: {
        inProgress: msg("Opening a pull request"),
        completed: msg("Opened a pull request"),
        failed: msg("Failed to open a pull request"),
        declined: msg("Declined to open a pull request"),
        stopped: msg("Stopped opening a pull request"),
        other: msg("Opening a pull request"),
      },
    },
  ],
  [
    "Update\nUpdating\nUpdated\na pull request",
    {
      detail: {
        inProgress: msg("Updating a pull request"),
        completed: msg("Updated a pull request"),
        failed: msg("Failed to update a pull request"),
        declined: msg("Declined to update a pull request"),
        stopped: msg("Stopped updating a pull request"),
        other: msg("Updating a pull request"),
      },
    },
  ],
  [
    "Respond\nResponding\nResponded\non a pull request",
    {
      detail: {
        inProgress: msg("Responding on a pull request"),
        completed: msg("Responded on a pull request"),
        failed: msg("Failed to respond on a pull request"),
        declined: msg("Declined to respond on a pull request"),
        stopped: msg("Stopped responding on a pull request"),
        other: msg("Responding on a pull request"),
      },
    },
  ],
  [
    "Review\nReviewing\nReviewed\na pull request",
    {
      detail: {
        inProgress: msg("Reviewing a pull request"),
        completed: msg("Reviewed a pull request"),
        failed: msg("Failed to review a pull request"),
        declined: msg("Declined to review a pull request"),
        stopped: msg("Stopped reviewing a pull request"),
        other: msg("Reviewing a pull request"),
      },
    },
  ],
  [
    "Read\nReading\nRead\nCI logs",
    {
      detail: {
        inProgress: msg("Reading CI logs"),
        completed: msg("Read CI logs"),
        failed: msg("Failed to read CI logs"),
        declined: msg("Declined to read CI logs"),
        stopped: msg("Stopped reading CI logs"),
        other: msg("Reading CI logs"),
      },
    },
  ],
  [
    "Re-run\nRe-running\nRe-ran\nCI",
    {
      detail: {
        inProgress: msg("Re-running CI"),
        completed: msg("Re-ran CI"),
        failed: msg("Failed to re-run CI"),
        declined: msg("Declined to re-run CI"),
        stopped: msg("Stopped re-running CI"),
        other: msg("Re-running CI"),
      },
    },
  ],
  [
    "Merge\nMerging\nMerged\na pull request",
    {
      detail: {
        inProgress: msg("Merging a pull request"),
        completed: msg("Merged a pull request"),
        failed: msg("Failed to merge a pull request"),
        declined: msg("Declined to merge a pull request"),
        stopped: msg("Stopped merging a pull request"),
        other: msg("Merging a pull request"),
      },
    },
  ],
  [
    "Ask\nAsking\nAsked\nthe user",
    {
      detail: {
        inProgress: msg("Asking the user"),
        completed: msg("Asked the user"),
        failed: msg("Failed to ask the user"),
        declined: msg("Declined to ask the user"),
        stopped: msg("Stopped asking the user"),
        other: msg("Asking the user"),
      },
    },
  ],
  [
    "Run\nRunning\nStarted\na command",
    {
      detail: {
        inProgress: msg("Running a command"),
        completed: msg("Started a command"),
        failed: msg("Failed to run a command"),
        declined: msg("Declined to run a command"),
        stopped: msg("Stopped running a command"),
        other: msg("Running a command"),
      },
    },
  ],
  [
    "Read\nReading\nRead\nterminal output",
    {
      detail: {
        inProgress: msg("Reading terminal output"),
        completed: msg("Read terminal output"),
        failed: msg("Failed to read terminal output"),
        declined: msg("Declined to read terminal output"),
        stopped: msg("Stopped reading terminal output"),
        other: msg("Reading terminal output"),
      },
    },
  ],
  [
    "Type in\nTyping in\nTyped in\na terminal",
    {
      detail: {
        inProgress: msg("Typing in a terminal"),
        completed: msg("Typed in a terminal"),
        failed: msg("Failed to type in a terminal"),
        declined: msg("Declined to type in a terminal"),
        stopped: msg("Stopped typing in a terminal"),
        other: msg("Typing in a terminal"),
      },
    },
  ],
  [
    "Check\nChecking\nChecked\nVisual Studio debugging",
    {
      detail: {
        inProgress: msg("Checking Visual Studio debugging"),
        completed: msg("Checked Visual Studio debugging"),
        failed: msg("Failed to check Visual Studio debugging"),
        declined: msg("Declined to check Visual Studio debugging"),
        stopped: msg("Stopped checking Visual Studio debugging"),
        other: msg("Checking Visual Studio debugging"),
      },
    },
  ],
  [
    "Evaluate\nEvaluating\nEvaluated\nan expression in Visual Studio",
    {
      detail: {
        inProgress: msg("Evaluating an expression in Visual Studio"),
        completed: msg("Evaluated an expression in Visual Studio"),
        failed: msg("Failed to evaluate an expression in Visual Studio"),
        declined: msg("Declined to evaluate an expression in Visual Studio"),
        stopped: msg("Stopped evaluating an expression in Visual Studio"),
        other: msg("Evaluating an expression in Visual Studio"),
      },
    },
  ],
  [
    "Control\nControlling\nControlled\nVisual Studio debugging",
    {
      detail: {
        inProgress: msg("Controlling Visual Studio debugging"),
        completed: msg("Controlled Visual Studio debugging"),
        failed: msg("Failed to control Visual Studio debugging"),
        declined: msg("Declined to control Visual Studio debugging"),
        stopped: msg("Stopped controlling Visual Studio debugging"),
        other: msg("Controlling Visual Studio debugging"),
      },
    },
  ],
  [
    "Set\nSetting\nSet\nVisual Studio auto-continue",
    {
      detail: {
        inProgress: msg("Setting Visual Studio auto-continue"),
        completed: msg("Set Visual Studio auto-continue"),
        failed: msg("Failed to set Visual Studio auto-continue"),
        declined: msg("Declined to set Visual Studio auto-continue"),
        stopped: msg("Stopped setting Visual Studio auto-continue"),
        other: msg("Setting Visual Studio auto-continue"),
      },
    },
  ],
  [
    "Use\nUsing\nUsed\nworkflow runs",
    {
      detail: {
        inProgress: msg("Using workflow runs"),
        completed: msg("Used workflow runs"),
        failed: msg("Failed to use workflow runs"),
        declined: msg("Declined to use workflow runs"),
        stopped: msg("Stopped using workflow runs"),
        other: msg("Using workflow runs"),
      },
    },
  ],
  [
    "Submit\nSubmitting\nSubmitted\nthe result",
    {
      detail: {
        inProgress: msg("Submitting the result"),
        completed: msg("Submitted the result"),
        failed: msg("Failed to submit the result"),
        declined: msg("Declined to submit the result"),
        stopped: msg("Stopped submitting the result"),
        other: msg("Submitting the result"),
      },
    },
  ],
  [
    "Resume\nResuming\nResumed\na held queue",
    {
      detail: {
        inProgress: msg("Resuming a held queue"),
        completed: msg("Resumed a held queue"),
        failed: msg("Failed to resume a held queue"),
        declined: msg("Declined to resume a held queue"),
        stopped: msg("Stopped resuming a held queue"),
        other: msg("Resuming a held queue"),
      },
    },
  ],
]);
