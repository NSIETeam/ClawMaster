/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import React from 'react';
import type { CommunitySkillCategory } from '../communitySkillCatalog.js';

const CATEGORY_LABELS: Readonly<Record<CommunitySkillCategory, string>> = {
  coding: '开发', design: '设计', office: '办公', research: '研究', automation: '自动化',
};

/** Registered semantic SVG used by the GitHub community-skill catalog. */
export function IconCommunitySkill({ category }: { category: CommunitySkillCategory }): React.JSX.Element {
  const common = {
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  };
  return <svg
    className={`claw-community-skill-card__icon is-${category}`}
    viewBox="0 0 24 24"
    role="img"
    aria-label={`${CATEGORY_LABELS[category]}插件`}
  >
    {category === 'coding' ? <><path {...common} d="m8.5 8-4 4 4 4"/><path {...common} d="m15.5 8 4 4-4 4"/><path {...common} d="m14 5-4 14"/></> : null}
    {category === 'design' ? <><path {...common} d="M12 3 5 10l4 4 7-7-4-4Z"/><path {...common} d="m14 9 5 5-5 5H9l-4-4 3-3"/><circle {...common} cx="15.5" cy="15.5" r="1"/></> : null}
    {category === 'office' ? <><path {...common} d="M6 3h9l3 3v15H6z"/><path {...common} d="M15 3v4h4M9 11h6M9 15h6M9 18h4"/></> : null}
    {category === 'research' ? <><circle {...common} cx="10.5" cy="10.5" r="5.5"/><path {...common} d="m15 15 4.5 4.5M10.5 8v5M8 10.5h5"/></> : null}
    {category === 'automation' ? <><path {...common} d="M8 4h8M9 4v3h6V4M7 9h10l2 4-2 7H7l-2-7z"/><circle {...common} cx="9.5" cy="14" r="1"/><circle {...common} cx="14.5" cy="14" r="1"/><path {...common} d="M9 17h6"/></> : null}
  </svg>;
}
