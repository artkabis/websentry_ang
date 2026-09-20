import type { CheckItem, CheckResult, DudaParams } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import { isEcommerceActive, parseDudaParameters, realValue } from '../duda-parameters.js';
import type { EffectiveSettings } from '../effective-settings.js';
import type { HtmlPage } from '../page.model.js';

/**
 * Informations Duda — critère purement INFORMATIF.
 *
 * Il ne note rien : son statut est `na`, donc hors score. Il alimente
 * l'encadré « Informations Duda » du rapport, le champ `dudaParams` et le
 * rattachement gamme/EPJ.
 */
export class DudaParamsAnalyzer extends BaseAnalyzer {
  readonly id = 'DUDA_PARAMS';
  readonly title = 'Informations Duda (window.Parameters)';

  /**
   * Toujours actif, même sous un profil de gamme restrictif.
   *
   * `DUDA_PARAMS` n'est listé dans aucun profil : le soumettre à
   * `enabledChecks` le désactiverait dès qu'une gamme est appliquée, et c'est
   * précisément là qu'on a besoin de savoir de quelle gamme il s'agit.
   */
  protected override isEnabled(): boolean {
    return true;
  }

  // `_settings` est reçu et DÉLIBÉRÉMENT ignoré : la signature garde la forme
  // commune aux analyseurs, et le paramètre nommé dit que l'oubli n'en est pas
  // un — ce critère ne se désactive pas.
  analyze(page: HtmlPage, _settings?: EffectiveSettings): Promise<CheckResult> {
    const params = parseDudaParameters(page.html);
    if (!params) {
      return Promise.resolve(
        this.na('Aucun window.Parameters trouvé — site non Duda ou page non reconnue.'),
      );
    }

    const items = describe(params);

    return Promise.resolve({
      checkId: this.id,
      checkTitle: this.title,
      globalScore: 5,
      // `na` et non `pass` : le critère constate, il ne juge pas. Le noter
      // ferait monter le score global d'un site simplement parce qu'il est
      // hébergé chez Duda.
      status: 'na',
      items,
      summary: `Paramètres Duda extraits — gamme : ${params.gamme ?? '—'}, EPJ : ${params.epj ?? '—'}.`,
      recommendations: [],
    });
  }
}

function describe(params: DudaParams): CheckItem[] {
  const items: CheckItem[] = [];
  const info = (label: string, value: string | number | null | undefined): void => {
    if (value === null || value === undefined || value === '') return;
    items.push({ label, value, status: 'info' });
  };

  info('URL du site', params.homeUrl);
  info('Account UUID', params.accountUUID);
  info('System ID', params.systemID);
  info('Site Alias', params.siteAlias);
  info('Type de site', params.siteType);
  info('Date de publication', params.publicationDate);
  info('Plan ID', params.planID);
  info('Product ID', params.productId);
  info('Langue par défaut', params.defaultLang);
  if (params.isMultilingual !== null) {
    info('Site multilingue', params.isMultilingual ? 'Oui' : 'Non');
  }

  if (params.externalUid) {
    info('Gamme', params.gamme ?? '—');
    info('EPJ (identifiant)', params.epj ?? '—');
    info('ExternalUid (brut)', params.externalUid);
  }

  if (!isEcommerceActive(params)) return items;

  items.push({ label: 'E-commerce actif', value: 'Oui', status: 'pass' });
  info('Store Page Alias', realValue(params.storePageAlias));
  info('Store Path', realValue(params.storePath));
  info('Store Base URL', realValue(params.storeBaseUrl));
  info('Store ID', realValue(params.storeId));
  info('Store Version', params.storeVersion);
  if (params.isNewStore !== null) info('Nouvelle boutique', params.isNewStore ? 'Oui' : 'Non');
  info('Store Pages URLs (base64)', params.storePagesUrls);

  return items;
}
