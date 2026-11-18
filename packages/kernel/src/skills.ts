/** Optional connection between isolated engines and the Neo Skill Registry. */
export interface SkillProjection {
  hermes(profile: string, home: string): Promise<string>;
  dsh(sessionId: string, home: string): Promise<void>;
  sync(profile: string, home: string): Promise<unknown>;
  removeAll(): Promise<void>;
}

export class SkillsBridge {
  private provider?: SkillProjection;
  private readonly hermesHomes = new Map<string, string>();
  private readonly dshHomes = new Map<string, string>();

  async attach(provider: SkillProjection): Promise<void> {
    if (this.provider) throw new Error('Skill registry already attached');
    this.provider = provider;
    try {
      for (const [profile, home] of this.hermesHomes) await provider.hermes(profile, home);
      for (const [sessionId, home] of this.dshHomes) await provider.dsh(sessionId, home);
    } catch (error) {
      this.provider = undefined;
      await provider.removeAll();
      throw error;
    }
  }

  async detach(provider: SkillProjection): Promise<void> {
    if (this.provider !== provider) return;
    this.provider = undefined;
    await provider.removeAll();
  }

  async hermesReady(profile: string, home: string): Promise<string | undefined> {
    this.hermesHomes.set(profile, home);
    return this.provider?.hermes(profile, home);
  }

  hermesHome(profile: string): string | undefined { return this.hermesHomes.get(profile); }

  forgetHermes(profile: string): void { this.hermesHomes.delete(profile); }

  async dshReady(sessionId: string, home: string): Promise<void> {
    this.dshHomes.set(sessionId, home);
    await this.provider?.dsh(sessionId, home);
  }

  forgetDsh(sessionId: string): void { this.dshHomes.delete(sessionId); }

  dshHome(sessionId: string): string | undefined { return this.dshHomes.get(sessionId); }

  sync(profile: string): Promise<unknown> {
    const home = this.hermesHomes.get(profile);
    return this.provider && home ? this.provider.sync(profile, home) : Promise.resolve([]);
  }
}
