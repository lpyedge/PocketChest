import type { ReactNode } from 'react';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { IconButton } from '@/components/IconButton';
import { HomeIcon } from '@/components/Icons';
import { useI18n } from '@/i18n/I18nProvider';
import { homeUrlFor } from '@/lib/home';

// The fixed top bar of the app pages: the project on the left; on the right the language, then the page icons
export function AppHeader({ children }: { children?: ReactNode }) {
	const { t, locale } = useI18n();
	return (
		<header className="sticky top-0 z-40 border-b border-gray-200 bg-white/90 backdrop-blur">
			<div className="mx-auto flex h-14 max-w-2xl items-center justify-between gap-3 px-4">
				<a href={homeUrlFor(locale)} className="flex min-w-0 items-center gap-2 font-semibold text-gray-900">
					<img src="/favicon.png" alt="" width="28" height="28" className="h-7 w-7 rounded-md" />
					<span className="hidden truncate text-base min-[420px]:inline">PocketChest</span>
				</a>
				<nav className="flex items-center gap-1" aria-label="PocketChest">
					<LanguageSwitcher />
					<IconButton label={t('nav.home')} href={homeUrlFor(locale)}>
						<HomeIcon />
					</IconButton>
					{children}
				</nav>
			</div>
		</header>
	);
}
