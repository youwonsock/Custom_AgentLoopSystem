const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const skillsSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'skills.js'), 'utf-8');

const fn = new Function(skillsSrc + `
  return { SKILLS, SkillManager };
`);
const { SKILLS, SkillManager } = fn();

describe('Skills - Definitions', () => {
  it('defines 5 skills', () => {
    assert.strictEqual(SKILLS.length, 5);
  });

  it('each skill has id, name, description, cooldown, icon', () => {
    for (const skill of SKILLS) {
      assert.ok(typeof skill.id === 'string' && skill.id.length > 0, `Skill missing id: ${JSON.stringify(skill)}`);
      assert.ok(typeof skill.name === 'string' && skill.name.length > 0, `Skill ${skill.id} missing name`);
      assert.ok(typeof skill.description === 'string' && skill.description.length > 0, `Skill ${skill.id} missing description`);
      assert.ok(typeof skill.cooldown === 'number' && skill.cooldown > 0, `Skill ${skill.id} bad cooldown`);
      assert.ok(typeof skill.icon === 'string' && skill.icon.length > 0, `Skill ${skill.id} missing icon`);
    }
  });

  it('all skill IDs are unique', () => {
    const ids = SKILLS.map(s => s.id);
    assert.strictEqual(new Set(ids).size, ids.length);
  });

  it('cooldowns are at least 15 seconds', () => {
    for (const skill of SKILLS) {
      assert.ok(skill.cooldown >= 15000, `Skill ${skill.id} cooldown too short`);
    }
  });

  it('expected skills are present', () => {
    const ids = SKILLS.map(s => s.id);
    assert.ok(ids.includes('block_swap'));
    assert.ok(ids.includes('column_clear'));
    assert.ok(ids.includes('chaos'));
    assert.ok(ids.includes('gravity_well'));
    assert.ok(ids.includes('mirror'));
  });
});

describe('SkillManager', () => {
  it('canUse returns false for unknown skill', () => {
    const mgr = new SkillManager();
    assert.strictEqual(mgr.canUse('nonexistent'), false);
  });

  it('canUse returns true for fresh skill', () => {
    const mgr = new SkillManager();
    assert.strictEqual(mgr.canUse('block_swap'), true);
  });

  it('use returns true for available skill', () => {
    const mgr = new SkillManager();
    assert.strictEqual(mgr.use('block_swap'), true);
  });

  it('use returns false immediately after use (cooldown active)', () => {
    const mgr = new SkillManager();
    mgr.use('block_swap');
    assert.strictEqual(mgr.canUse('block_swap'), false);
    assert.strictEqual(mgr.use('block_swap'), false);
  });

  it('use returns false for unknown skill', () => {
    const mgr = new SkillManager();
    assert.strictEqual(mgr.use('nonexistent'), false);
  });

  it('getRemainingCooldown returns 0 for unused skill', () => {
    const mgr = new SkillManager();
    assert.strictEqual(mgr.getRemainingCooldown('block_swap'), 0);
  });

  it('getRemainingCooldown returns > 0 after use', () => {
    const mgr = new SkillManager();
    mgr.use('block_swap');
    assert.ok(mgr.getRemainingCooldown('block_swap') > 0);
  });

  it('getRemainingCooldown returns 0 for unknown skill', () => {
    const mgr = new SkillManager();
    assert.strictEqual(mgr.getRemainingCooldown('nonexistent'), 0);
  });

  it('getProgress returns 1 for unused skill', () => {
    const mgr = new SkillManager();
    assert.strictEqual(mgr.getProgress('block_swap'), 1);
  });

  it('getProgress returns between 0 and 1 after use', () => {
    const mgr = new SkillManager();
    mgr.use('block_swap');
    const progress = mgr.getProgress('block_swap');
    assert.ok(progress >= 0 && progress < 1);
  });

  it('getProgress returns 1 for unknown skill', () => {
    const mgr = new SkillManager();
    assert.strictEqual(mgr.getProgress('nonexistent'), 1);
  });

  it('cooldowns are independent per skill', () => {
    const mgr = new SkillManager();
    mgr.use('block_swap');
    assert.strictEqual(mgr.canUse('block_swap'), false);
    assert.strictEqual(mgr.canUse('column_clear'), true);
    assert.strictEqual(mgr.use('column_clear'), true);
  });

  it('canUse returns true after cooldown expires', { timeout: 16000 }, async () => {
    const mgr = new SkillManager();
    const skill = SKILLS.find(s => s.cooldown === 15000);
    assert.ok(skill, 'Expected block_swap with 15s cooldown');
    mgr.use(skill.id);
    assert.strictEqual(mgr.canUse(skill.id), false);
    await new Promise(resolve => setTimeout(resolve, 15100));
    assert.strictEqual(mgr.canUse(skill.id), true);
  });
});
