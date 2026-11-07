package expo.modules.t3agentnotifications

import android.content.Context
import android.graphics.Typeface
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

internal data class ActivityRow(val status: String, val title: String, val project: String)

/** `status` is the relay's row key; `label` and `chip` are what the user reads. */
internal enum class ActivityPhase(
  val status: String,
  val label: Int,
  val chip: Int,
  val color: Int
) {
  STARTING(
    "Connecting",
    R.string.agent_activity_status_connecting,
    R.string.agent_activity_chip_working,
    R.color.agent_activity_working
  ),
  RUNNING(
    "Working",
    R.string.agent_activity_status_working,
    R.string.agent_activity_chip_working,
    R.color.agent_activity_working
  ),
  APPROVAL(
    "Approval",
    R.string.agent_activity_status_approval,
    R.string.agent_activity_chip_approve,
    R.color.agent_activity_attention
  ),
  INPUT(
    "Input",
    R.string.agent_activity_status_question,
    R.string.agent_activity_chip_answer,
    R.color.agent_activity_input
  ),
  STALE(
    "Waiting",
    R.string.agent_activity_status_waiting,
    R.string.agent_activity_chip_waiting,
    R.color.agent_activity_waiting
  ),
  COMPLETED(
    "Done",
    R.string.agent_activity_status_done,
    R.string.agent_activity_chip_done,
    R.color.agent_activity_done
  ),
  FAILED(
    "Failed",
    R.string.agent_activity_status_failed,
    R.string.agent_activity_chip_failed,
    R.color.agent_activity_failed
  );

  val needsUser get() = this == APPROVAL || this == INPUT
  val finished get() = this == COMPLETED || this == FAILED

  companion object {
    fun forStatus(status: String) = entries.firstOrNull { it.status == status }
  }
}

/** The relay orders rows and their deep link together; never reorder them in the client. */
internal fun activityRows(data: Map<String, String>) = (0..4).mapNotNull {
  val parts = data["activity_line_$it"]?.split('\t', limit = 3) ?: return@mapNotNull null
  if (parts.size != 3 || parts[1].isBlank()) {
    null
  } else {
    ActivityRow(parts[0].take(40), parts[1].take(120), parts[2].take(120))
  }
}

internal fun activityPhase(data: Map<String, String>, rows: List<ActivityRow>): ActivityPhase? =
  when (data["activity_phase"]?.takeIf { it.isNotBlank() }) {
    "starting" -> ActivityPhase.STARTING
    "running" -> ActivityPhase.RUNNING
    "waiting_for_approval" -> ActivityPhase.APPROVAL
    "waiting_for_input" -> ActivityPhase.INPUT
    "stale" -> ActivityPhase.STALE
    "completed" -> ActivityPhase.COMPLETED
    "failed" -> ActivityPhase.FAILED
    else -> rows.firstOrNull()?.let { ActivityPhase.forStatus(it.status) }
  }

/** `strings` is the context in the app's chosen language; colors and intents use the real one. */
internal class ActivityPresentation(
  data: Map<String, String>,
  private val active: Boolean,
  private val strings: Context
) {
  private val rows = activityRows(data)
  private val hero = rows.firstOrNull()
  val phase = activityPhase(data, rows)
  private val activeCount = data["activity_active_count"]?.toIntOrNull()?.coerceAtLeast(0)
    ?: rows.count { ActivityPhase.forStatus(it.status)?.finished != true }
  private val attentionCount = data["activity_attention_count"]?.toIntOrNull()?.coerceAtLeast(0)
    ?: rows.count { ActivityPhase.forStatus(it.status)?.needsUser == true }
  private val failedCount = rows.count { it.status == ActivityPhase.FAILED.status }
  private val threadCount =
    activeCount + rows.count { ActivityPhase.forStatus(it.status)?.finished == true }
  private val singleProject = rows.map { it.project }.distinct().size == 1
  private val legacyBody = (0..4).mapNotNull { data["activity_line_$it"]?.take(300) }
    .takeIf { it.isNotEmpty() }?.joinToString("\n")
    ?: data["activity_body"].orEmpty().take(240)

  val summary: String = when {
    hero == null -> data["activity_title"]?.takeIf { it.isNotBlank() }?.take(120)
      ?: strings.getString(R.string.agent_activity_title)
    rows.size == 1 -> hero.title
    attentionCount > 0 -> plural(R.plurals.agent_activity_need_you, attentionCount)
    activeCount > 0 && failedCount > 0 ->
      strings.getString(R.string.agent_activity_failed_count, failedCount)
    activeCount > 0 -> plural(R.plurals.agent_activity_working, activeCount)
    failedCount > 0 -> strings.getString(R.string.agent_activity_finished_failed, failedCount)
    else -> strings.getString(R.string.agent_activity_all_finished)
  }

  val chip: String? = when {
    !active -> null
    phase == null -> data["activity_chip"]?.takeIf { it.isNotBlank() }?.take(7)
      ?: strings.getString(R.string.agent_activity_chip_active)
    phase == ActivityPhase.RUNNING && activeCount > 1 ->
      strings.getString(
        R.string.agent_activity_chip_live,
        if (activeCount > 9) "9+" else activeCount.toString()
      )
    else -> strings.getString(phase.chip)
  }

  // Every action opens the thread; nothing here approves or answers from the notification.
  val action: String? = if (active) strings.getString(R.string.agent_activity_open) else null

  private fun plural(id: Int, count: Int) = strings.resources.getQuantityString(id, count, count)

  fun applyTo(builder: NotificationCompat.Builder, context: Context) {
    val tint = phase?.let { ContextCompat.getColor(context, it.color) }
    builder.setSmallIcon(R.drawable.agent_activity_mark)
    if (tint != null) builder.setColor(tint)
    // Tint the summary only when it names an outcome or a request; a plain
    // "3 working" stays neutral so the accent keeps meaning something.
    val tintedSummary = tint != null && rows.size > 1 && phase != ActivityPhase.RUNNING &&
      phase != ActivityPhase.STARTING
    builder.setContentTitle(if (tintedSummary) tinted(summary, tint!!) else summary)
    if (rows.size > 1) {
      builder.setSubText(
        listOfNotNull(
          hero!!.project.takeIf { singleProject && it.isNotBlank() },
          if (activeCount > 0) {
            plural(R.plurals.agent_activity_active, activeCount)
          } else {
            plural(R.plurals.agent_activity_threads, threadCount)
          }
        ).joinToString(" · ")
      )
    }
    val body = body(context)
    val lineBreak = body.indexOf('\n')
    val firstLine = if (lineBreak >= 0) body.subSequence(0, lineBreak) else body
    builder.setContentText(firstLine).setStyle(NotificationCompat.BigTextStyle().bigText(body))
    // Thread update timestamps can change while an approval remains pending.
    // Leave the timer hidden until the payload has a stable phase-entry timestamp.
    builder.setShowWhen(false).setUsesChronometer(false)
  }

  private fun body(context: Context): CharSequence = when {
    hero == null -> legacyBody
    rows.size == 1 -> statusLine(context, hero.copy(title = hero.project), "")
    else -> SpannableStringBuilder().apply {
      rows.forEachIndexed { index, row ->
        if (index > 0) append("\n")
        append(statusLine(context, row, row.project.takeUnless { singleProject }.orEmpty()))
      }
    }
  }

  private fun statusLine(context: Context, row: ActivityRow, trailing: String): CharSequence =
    SpannableStringBuilder().apply {
      val status = ActivityPhase.forStatus(row.status)
      val color = ContextCompat.getColor(context, status?.color ?: R.color.agent_activity_waiting)
      append(tinted(status?.let { strings.getString(it.label) } ?: row.status, color, bold = true))
      append(" ").append(row.title)
      // Promoted cards drop text color, so the separator has to do the work of the dimming.
      if (trailing.isNotBlank()) {
        val start = length
        append(" · ").append(trailing)
        setSpan(
          ForegroundColorSpan(ContextCompat.getColor(context, R.color.agent_activity_waiting)),
          start,
          length,
          Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
        )
      }
    }

  private fun tinted(text: String, color: Int, bold: Boolean = false) =
    SpannableStringBuilder(text).apply {
      setSpan(ForegroundColorSpan(color), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      if (bold) setSpan(StyleSpan(Typeface.BOLD), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
}
