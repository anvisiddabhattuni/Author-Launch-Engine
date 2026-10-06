import { useLocation } from 'react-router-dom';

/**
 * The words people navigate by: section names, role names and the one-line
 * explanation at the top of every page. Kept in one place so a name means the
 * same thing everywhere, and written for someone who has never used the app.
 */
export const ROLE_LABEL = {
  author: 'Author',
  admin: 'Admin',
  compliance: 'Auditor · read-only',
};

/** Each page's title and what it is for, in a sentence. */
export const PAGES = {
  '/upload': ['My books', 'Add your book and a few of your past posts. Everything the app writes starts from these.'],
  '/review': ['Review posts', 'Read each post the app has drafted and decide: approve it, ask for changes, or reject it. Nothing is posted without your approval.'],
  '/schedule': ['Schedule', 'Choose when your approved posts go out.'],
  '/performance': ['Results', 'How your published posts are doing — likes, shares and comments.'],
  '/opportunities': ['Opportunities', 'Podcasts, events and talks that suit your book.'],
  '/outreach': ['Outreach', 'Draft pitches to the opportunities you like. Each one waits for your approval before it is sent.'],
  '/press': ['Press', 'Press releases, your author bio and fact sheets for milestones like a launch, and who should review them.'],
  '/trust': ['Trust & safety', 'Anything that needs a person’s attention, and how well the safety checks are holding.'],
  '/audit': ['Activity history', 'A permanent record of everything that happened, who did it and when.'],
  '/templates': ['Image templates', 'The picture layouts used for image posts, and whether each one may be used.'],
  '/worker': ['Background tasks', 'Work the app does on its own schedule — publishing, reminders and checks.'],
  '/billing': ['Billing', 'Your subscription and payments.'],
  '/api-keys': ['API keys', 'Keys that let other software read your data. Only create one if someone technical asks for it.'],
  '/tenants': ['Authors', 'Every author account: invite new authors and see who has joined.'],
  '/access': ['Team access', 'Who can do what. Changes need a second admin to approve them.'],
  '/security': ['Security', 'Sign-in attempts and access that was refused, and alerts about them.'],
};

/** Sections, grouped by what people come to do. Admin-only ones appear only for those who can use them. */
export function navGroups(user) {
  const can = (p) => Boolean(user.permissions?.includes(p));
  const groups = [
    { label: 'Your posts', items: [['/upload', 'My books'], ['/review', 'Review posts'], ['/schedule', 'Schedule'], ['/performance', 'Results']] },
    { label: 'Getting noticed', items: [['/opportunities', 'Opportunities'], ['/outreach', 'Outreach'], ['/press', 'Press']] },
    {
      label: 'Safety & settings',
      items: [
        ['/trust', 'Trust & safety'],
        // STORY-050: only for those who may read it.
        ...(can('audit.read') ? [['/audit', 'Activity history']] : []),
        ['/templates', 'Image templates'],
        ['/worker', 'Background tasks'],
        // STORY-036 / STORY-045: the author's own, and admins who manage authors.
        ...(user.authorId || can('tenant.manage') ? [['/billing', 'Billing'], ['/api-keys', 'API keys']] : []),
      ],
    },
  ];
  // STORY-042/043/044: admin pages, only for those who can use them.
  const admin = [
    ...(can('tenant.read.all') ? [['/tenants', 'Authors']] : []),
    ...(can('access.manage') || (can('audit.read') && can('tenant.read.all')) ? [['/access', 'Team access'], ['/security', 'Security']] : []),
  ];
  if (admin.length) groups.push({ label: 'Admin', items: admin });
  return groups;
}

/** The page's title and its one-line explanation, under the navigation. */
export function PageIntro() {
  const { pathname } = useLocation();
  const page = PAGES[pathname];
  if (!page) return null;
  return (
    <div className="page-intro">
      <h1 className="page-title">{page[0]}</h1>
      <p>{page[1]}</p>
    </div>
  );
}
