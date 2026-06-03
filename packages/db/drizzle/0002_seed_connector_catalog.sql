INSERT INTO "connector_catalog" (
  "toolkit_slug",
  "display_name",
  "description",
  "logo_path",
  "logo_url",
  "source",
  "created_at",
  "updated_at"
) VALUES
  (
    'facebook',
    'Facebook',
    'Facebook is a social media and advertising platform used by individuals and businesses to connect, share content, and promote products or services. Only supports Facebook Pages, not Facebook Personal accounts.',
    NULL,
    'https://logos.composio.dev/api/facebook',
    'admin',
    NOW(),
    NOW()
  ),
  (
    'github',
    'GitHub',
    'GitHub hosts code, pull requests, issues, and development history. Finn can use it to understand engineering work, follow changes, and help with code-related context across repos, PRs, and issues.',
    '/icons/connectors/github.svg',
    NULL,
    'admin',
    NOW(),
    NOW()
  ),
  (
    'gmail',
    'Gmail',
    'Gmail is your email inbox from Google. Finn can use it to understand important messages, find context from past emails, and help you keep track of replies, plans, updates, and things that need attention.',
    '/icons/connectors/gmail.svg',
    NULL,
    'admin',
    NOW(),
    NOW()
  ),
  (
    'googlecalendar',
    'Google Calendar',
    'Google Calendar keeps track of your events, meetings, and plans. Finn can use it to understand what is coming up, help you prepare, and keep your day organized around the things already on your schedule.',
    '/icons/connectors/calendar.svg',
    NULL,
    'admin',
    NOW(),
    NOW()
  ),
  (
    'googledrive',
    'Google Drive',
    'Google Drive stores your files, docs, sheets, and shared folders. Finn can use it to find relevant documents, understand project context, and help you work from the files you already have.',
    '/icons/connectors/drive.svg',
    NULL,
    'admin',
    NOW(),
    NOW()
  ),
  (
    'instagram',
    'Instagram',
    'Instagram is a social media platform for sharing photos, videos, and stories. Only supports Instagram Business and Creator accounts, not Instagram Personal accounts.',
    NULL,
    'https://logos.composio.dev/api/instagram',
    'admin',
    NOW(),
    NOW()
  ),
  (
    'linear',
    'Linear',
    'Linear tracks issues, projects, and product work. Finn can use it to understand what is planned or in progress, follow ticket context, and help you stay on top of priorities and next steps.',
    '/icons/connectors/linear.svg',
    NULL,
    'admin',
    NOW(),
    NOW()
  ),
  (
    'notion',
    'Notion',
    'Notion is a workspace for notes, docs, wikis, and project information. Finn can use it to find relevant context, understand how things are organized, and help you work from the knowledge your team already keeps there.',
    '/icons/connectors/notion.png',
    NULL,
    'admin',
    NOW(),
    NOW()
  ),
  (
    'outlook',
    'Outlook',
    'Outlook is Microsoft''s email inbox for messages, work updates, and conversations. Finn can use it to understand important emails, find context from past threads, and help you keep track of replies, plans, and things that need attention.',
    '/icons/connectors/outlook.png',
    NULL,
    'admin',
    NOW(),
    NOW()
  )
ON CONFLICT ("toolkit_slug") DO UPDATE SET
  "display_name" = EXCLUDED."display_name",
  "description" = EXCLUDED."description",
  "logo_path" = EXCLUDED."logo_path",
  "logo_url" = EXCLUDED."logo_url",
  "source" = EXCLUDED."source",
  "updated_at" = EXCLUDED."updated_at"
WHERE "connector_catalog"."source" <> 'admin';
