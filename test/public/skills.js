const SKILLS = [
  {
    id: 'block_swap',
    name: 'Block Swap',
    description: 'Replace opponent\'s active piece with a random piece type',
    cooldown: 15000,
    icon: '🔄',
  },
  {
    id: 'column_clear',
    name: 'Column Clear',
    description: 'Delete a random column from opponent\'s board',
    cooldown: 20000,
    icon: '🗑️',
  },
  {
    id: 'chaos',
    name: 'Chaos',
    description: 'Randomize all block positions on opponent\'s board',
    cooldown: 25000,
    icon: '🌀',
  },
  {
    id: 'gravity_well',
    name: 'Gravity Well',
    description: 'Drop all gaps to the bottom of opponent\'s board',
    cooldown: 18000,
    icon: '⬇️',
  },
  {
    id: 'mirror',
    name: 'Mirror',
    description: 'Flip opponent\'s board horizontally',
    cooldown: 22000,
    icon: '🪞',
  },
];

class SkillManager {
  constructor() {
    this.cooldowns = {};
    this.lastUsed = {};
    for (const skill of SKILLS) {
      this.cooldowns[skill.id] = 0;
      this.lastUsed[skill.id] = 0;
    }
  }

  canUse(skillId) {
    const skill = SKILLS.find(s => s.id === skillId);
    if (!skill) return false;
    return Date.now() - this.lastUsed[skillId] >= skill.cooldown;
  }

  use(skillId) {
    if (!this.canUse(skillId)) return false;
    this.lastUsed[skillId] = Date.now();
    return true;
  }

  getRemainingCooldown(skillId) {
    const skill = SKILLS.find(s => s.id === skillId);
    if (!skill) return 0;
    const elapsed = Date.now() - this.lastUsed[skillId];
    return Math.max(0, skill.cooldown - elapsed);
  }

  getProgress(skillId) {
    const skill = SKILLS.find(s => s.id === skillId);
    if (!skill) return 1;
    const elapsed = Date.now() - this.lastUsed[skillId];
    return Math.min(1, elapsed / skill.cooldown);
  }
}
