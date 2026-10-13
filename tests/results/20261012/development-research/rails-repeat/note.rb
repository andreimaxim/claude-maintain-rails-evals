class Note < ApplicationRecord
  HIGHLIGHT_COLORS = %w[ yellow green blue pink ]
  MAXIMUM_ATTACHMENT_SIZE = 1.megabyte

  belongs_to :notebook
  belongs_to :import, optional: true
  belongs_to :citation, optional: true, foreign_key: :citation_doi, validate: true
  has_rich_text :body

  enum :status, { draft: 0, ready: 1 }, prefix: true

  serialize :tags, coder: JSON
  store_accessor :settings, :color
  alias_method :highlight_color, :color
  alias_method :highlight_color=, :color=

  validates :title, presence: true
  validates :color, inclusion: { in: HIGHLIGHT_COLORS }, allow_blank: true
  validates :reminder_epoch, numericality: { only_integer: true, greater_than: 0, less_than: 10_000_000_000 }, allow_nil: true
  validate :attachments_are_small

  scope :newest_first, -> { order(created_at: :desc, id: :desc) }
  scope :titled_like, ->(query) { where("notes.title ILIKE ?", "%#{sanitize_sql_like(query)}%") }

  def doi
    citation_doi
  end

  # Cites the shared citation with this exact DOI, ignoring surrounding whitespace.
  # A blank DOI removes the citation from the note.
  def doi=(doi)
    doi = doi.to_s.strip
    self.citation = (Citation.find_or_initialize_by(doi: doi) if doi.present?)
  end

  # The reminder time in the reader's time zone.
  def reminder_at
    Time.find_zone!(notebook.user.time_zone).at(reminder_epoch) if reminder_epoch
  end

  # Twenty-four elapsed hours after the reminder time, for postponing it a day.
  # The result keeps the reminder's UTC offset, so across a daylight saving
  # change its wall-clock time differs from the reader's local time.
  def next_day_reminder_at
    reminder_at.getlocal(reminder_at.utc_offset) + 86_400
  end

  def reminder_scheduled?
    reminder_job_id.present? && reminder_sent_at.nil?
  end

  # Schedules an email reminder at the given time in seconds since 1970, by
  # default the stored one, such as an imported reminder. It replaces any
  # earlier reminder for this note: the earlier job sends nothing when it runs.
  # Returns whether the reminder was scheduled. The job is queued under the row
  # lock, so a failed enqueue leaves the previous reminder in place.
  def schedule_reminder(epoch = reminder_epoch)
    with_lock do
      self.reminder_epoch = epoch

      if reminder_epoch && valid?
        job = NoteReminderJob.set(wait_until: Time.at(reminder_epoch)).perform_later(self)
        update!(reminder_job_id: job.job_id, reminder_sent_at: nil)
      else
        errors.add(:base, "Choose a date and time for the reminder") if reminder_epoch.nil?
        restore_attributes([:reminder_epoch])
        false
      end
    end
  end

  def postpone_reminder
    reminder_scheduled? && schedule_reminder(next_day_reminder_at.to_i)
  end

  # Sends the reminder if the given job is still the one scheduled for it.
  # Taking the row lock waits for the request that queued the job to commit.
  def send_reminder(job_id)
    with_lock do
      if reminder_job_id == job_id && reminder_scheduled?
        update!(reminder_sent_at: Time.current)
        ReminderMailer.with(note: self).note_reminder.deliver_now
      end
    end
  end

  def tag_list
    tags.join(", ")
  end

  def tag_list=(list)
    self.tags = list.to_s.split(",").map(&:strip).reject(&:blank?).uniq
  end

  private
    def attachments_are_small
      if body.body&.attachables.to_a.grep(ActiveStorage::Blob).any? { |blob| blob.byte_size > MAXIMUM_ATTACHMENT_SIZE }
        errors.add(:body, "attachments must be #{ActiveSupport::NumberHelper.number_to_human_size(MAXIMUM_ATTACHMENT_SIZE)} or smaller")
      end
    end
end
