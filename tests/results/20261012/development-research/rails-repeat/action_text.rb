# Rich text may contain collapsible excerpts. Extend Action Text's default
# allowlist, which keeps the safe defaults and attachment markup.
ActionText::ContentHelper.allowed_tags =
  ActionText::ContentHelper.sanitizer.class.allowed_tags +
  [ ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary" ]
